import Plugin, { Tree } from 'broccoli-plugin';
import { join } from 'path';
import walkSync from 'walk-sync';
import { unlinkSync, rmdirSync, mkdirSync, readFileSync, existsSync, writeFileSync, removeSync, readdirSync } from 'fs-extra';
import FSTree from 'fs-tree-diff';
import symlinkOrCopy from 'symlink-or-copy';
import uniqBy from 'lodash/uniqBy';
import sourceMappingURL from 'source-map-url';

/*
  This is a fairly specialized broccoli transform that we use to get the output
  of our webpack build added to the ember app. Mostly it's needed because we're
  forced to run quite late and use the postprocessTree hook, rather than nicely
  emit our content as part of treeForVendor, etc, which would be easier but
  doesn't work because of whack data dependencies in new versions of ember-cli's
  broccoli graph.
*/

export interface AppendOptions {
  // map from a directory in the appendedTree (like `entrypoints/app`) to a file
  // that may exists in the upstreamTree (like `assets/vendor.js`). Appends the
  // JS files in the directory to that file, when it exists.
  mappings: Map<string, string>;

  // map from a directory in the appendedTree (like `lazy`) to a directory where
  // we will output those files in the output (like `assets`).
  passthrough: Map<string, string>;
}

export default class Append extends Plugin {
  private previousUpstreamTree = new FSTree();
  private previousAppendedTree = new FSTree();
  private mappings: Map<string, string>;
  private reverseMappings: Map<string, string>;
  private passthrough: Map<string, string>;

  constructor(upstreamTree: Tree, appendedTree: Tree, options: AppendOptions) {
    super([upstreamTree, appendedTree], {
      annotation: 'ember-auto-import-analyzer',
      persistentOutput: true
    });

    let reverseMappings = new Map();
    for (let [key, value] of options.mappings.entries( )) {
      reverseMappings.set(value, key);
    }

    this.mappings = options.mappings;
    this.reverseMappings = reverseMappings;
    this.passthrough = options.passthrough;
  }

  private get upstreamDir() {
    return this.inputPaths[0];
  }

  private get appendedDir() {
    return this.inputPaths[1];
  }

  // returns the set of output files that should change based on changes to the
  // appendedTree.
  private diffAppendedTree() {
    let changed = new Set();
    let { patchset, passthroughEntries } = this.appendedPatchset();
    for (let [, relativePath] of patchset) {
      let [first] = relativePath.split('/');
      if (this.mappings.has(first)) {
        changed.add(this.mappings.get(first));
      }
    }
    return { needsUpdate: changed, passthroughEntries };
  }

  build() {
    // First note which output files should change due to changes in the
    // appendedTree
    let { needsUpdate, passthroughEntries } = this.diffAppendedTree();

    // Then process all changes in the upstreamTree
    for (let [operation, relativePath, entry] of this.upstreamPatchset(passthroughEntries)) {
      let outputPath = join(this.outputPath, relativePath);
      switch (operation) {
        case 'unlink':
          unlinkSync(outputPath);
          break;
        case 'rmdir':
          rmdirSync(outputPath);
          break;
        case 'mkdir':
          mkdirSync(outputPath);
          break;
        case 'change':
          removeSync(outputPath);
          // deliberate fallthrough
        case 'create':
          if (this.reverseMappings.has(relativePath)) {
            // this is where we see the upstream original file being created or
            // modified. We should always generate the complete appended file here.
            this.handleAppend(relativePath);
            // it no longer needs update once we've handled it here
            needsUpdate.delete(relativePath);
          } else {
            if (entry.isPassthrough) {
              symlinkOrCopy.sync(join(this.appendedDir, entry.originalRelativePath), outputPath);
            } else {
              symlinkOrCopy.sync(join(this.upstreamDir, relativePath), outputPath);
            }
          }
      }
    }

    // finally, any remaining things in `needsUpdate` are cases where the
    // appendedTree changed but the corresponding file in the upstreamTree
    // didn't. Those needs to get handled here.
    for (let relativePath of needsUpdate.values()) {
      this.handleAppend(relativePath);
    }
  }

  private upstreamPatchset(passthroughEntries) {
    let input = walkSync.entries(this.upstreamDir).concat(passthroughEntries);

    // FSTree requires the entries to be sorted and uniq
    input.sort((a,b) => a.relativePath.localeCompare(b.relativePath));
    input = uniqBy(input, e => (e as any).relativePath);

    let previous = this.previousUpstreamTree;
    let next = (this.previousUpstreamTree = FSTree.fromEntries(input));
    return previous.calculatePatch(next);
  }

  private appendedPatchset() {
    let input = walkSync.entries(this.appendedDir);
    let passthroughEntries = input
      .map(e => {
        let first = e.relativePath.split('/')[0];
        let remapped = this.passthrough.get(first);
        if (remapped) {
          let o = Object.create(e);
          o.relativePath = e.relativePath.replace(new RegExp('^' + first), remapped);
          o.isPassthrough = true;
          o.originalRelativePath = e.relativePath;
          return o;
        }
      }).filter(Boolean);

    let previous = this.previousAppendedTree;
    let next = (this.previousAppendedTree = FSTree.fromEntries(input));
    return { patchset: previous.calculatePatch(next), passthroughEntries };
  }

  private handleAppend(relativePath) {
    let upstreamPath = join(this.upstreamDir, relativePath);
    let outputPath = join(this.outputPath, relativePath);

    if (!existsSync(upstreamPath)) {
      removeSync(outputPath);
      return;
    }

    let sourceDir = join(this.appendedDir, this.reverseMappings.get(relativePath));
    if (!existsSync(sourceDir)) {
      symlinkOrCopy.sync(upstreamPath, outputPath);
      return;
    }

    let appendedContent = readdirSync(sourceDir).map(name => {
      if (/\.js$/.test(name)) {
        return readFileSync(join(sourceDir, name), 'utf8');
      }
    }).filter(Boolean).join(";\n");
    let upstreamContent = readFileSync(upstreamPath, 'utf8');
    if (appendedContent.length > 0) {
      upstreamContent = sourceMappingURL.insertBefore(upstreamContent, ";\n" + appendedContent);
    }
    writeFileSync(outputPath, upstreamContent, 'utf8');
  }
}