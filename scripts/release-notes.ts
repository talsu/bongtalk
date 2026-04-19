/**
 * Minimal release-notes generator — called by the release-manager subagent.
 * Produces a markdown summary of commits since the last tag.
 */
import { execSync } from 'node:child_process';

function sh(cmd: string): string {
  try {
    return execSync(cmd).toString().trim();
  } catch {
    return '';
  }
}

const lastTag = sh('git describe --tags --abbrev=0') || '';
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = sh(`git log ${range} --pretty=format:"- %s (%h)"`) || '(no commits)';

console.log(`# Release notes\n`);
console.log(`Range: ${lastTag || 'initial'}..HEAD\n`);
console.log(commits);
