import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const tauriConfPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(repoRoot, 'src-tauri', 'Cargo.lock');
const tauriDir = path.join(repoRoot, 'src-tauri');
const releaseBodyRelative = '.github/tauri-release-body.md';
const releaseBodyPath = path.join(repoRoot, releaseBodyRelative);

const DEFAULT_RELEASE_BODY =
  'See release assets for the Windows installers, updater package, and unsigned macOS disk image.';

function parseSemver(s) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s).trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function versionToGitTag(version) {
  return `v${version}`;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getCargoPackageVersion(cargoTomlText) {
  const lines = cargoTomlText.split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1].trim() === 'package';
      continue;
    }

    if (inPackage) {
      const match = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
      if (match) {
        return match[1];
      }
    }
  }

  return null;
}

function setCargoPackageVersion(cargoTomlText, newVersion) {
  const lines = cargoTomlText.split(/\r?\n/);
  const eol = cargoTomlText.includes('\r\n') ? '\r\n' : '\n';
  let inPackage = false;
  let replaced = false;
  const nextLines = lines.map((line) => {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1].trim() === 'package';
      return line;
    }

    if (inPackage && /^\s*version\s*=\s*"/.test(line)) {
      replaced = true;
      return line.replace(/^(\s*version\s*=\s*")[^"]*(".*)$/, `$1${newVersion}$2`);
    }

    return line;
  });

  if (!replaced) {
    throw new Error(`Could not find [package] version in ${cargoTomlPath}`);
  }

  return nextLines.join(eol);
}

function bumpSemver(current, kind) {
  const parsed = parseSemver(current);
  if (!parsed) {
    return null;
  }

  if (kind === 'major') {
    return `${parsed.major + 1}.0.0`;
  }

  if (kind === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function gitTagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitRemoteExists(name) {
  try {
    execFileSync('git', ['remote', 'get-url', name], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function runGit(args, inheritIo = true) {
  execFileSync('git', args, {
    cwd: repoRoot,
    stdio: inheritIo ? 'inherit' : 'pipe',
    encoding: 'utf8',
  });
}

function runCargoGenerateLockfile() {
  execFileSync('cargo', ['generate-lockfile'], {
    cwd: tauriDir,
    stdio: 'inherit',
  });
}

function runProductionBuild() {
  execSync('pnpm build', {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
}

function restoreFiles(snapshot) {
  writeFileSync(packageJsonPath, snapshot.packageJsonRaw, 'utf8');
  writeFileSync(tauriConfPath, snapshot.tauriConfRaw, 'utf8');
  writeFileSync(cargoTomlPath, snapshot.cargoTomlRaw, 'utf8');

  if (snapshot.cargoLockRaw === null) {
    try {
      unlinkSync(cargoLockPath);
    } catch {}
  } else {
    writeFileSync(cargoLockPath, snapshot.cargoLockRaw, 'utf8');
  }

  if (snapshot.releaseBodyRaw === null) {
    try {
      unlinkSync(releaseBodyPath);
    } catch {}
  } else {
    writeFileSync(releaseBodyPath, snapshot.releaseBodyRaw, 'utf8');
  }
}

async function readReleaseNotes(rl) {
  console.log('');
  console.log('Release notes for the GitHub release.');
  console.log(
    'Press Enter once to use the default message, or enter multiple lines and finish with an empty line.',
  );
  console.log('');
  console.log(`Default:\n  ${DEFAULT_RELEASE_BODY}\n`);

  const lines = [];
  while (true) {
    const prompt = lines.length === 0 ? 'Notes (Enter = default): ' : 'Notes (empty line ends): ';
    const line = await rl.question(prompt);

    if (lines.length === 0 && line.trim() === '') {
      return DEFAULT_RELEASE_BODY;
    }

    if (lines.length > 0 && line === '') {
      return lines.join('\n');
    }

    lines.push(line);
  }
}

async function main() {
  if (!gitRemoteExists('origin')) {
    throw new Error(
      'Missing git remote "origin". Configure the canonical release remote before bumping and pushing a tag.',
    );
  }

  const snapshot = {
    packageJsonRaw: readFileSync(packageJsonPath, 'utf8'),
    tauriConfRaw: readFileSync(tauriConfPath, 'utf8'),
    cargoTomlRaw: readFileSync(cargoTomlPath, 'utf8'),
    cargoLockRaw: existsSync(cargoLockPath) ? readFileSync(cargoLockPath, 'utf8') : null,
    releaseBodyRaw: existsSync(releaseBodyPath) ? readFileSync(releaseBodyPath, 'utf8') : null,
  };

  const packageJson = JSON.parse(snapshot.packageJsonRaw);
  const tauriConf = JSON.parse(snapshot.tauriConfRaw);
  const cargoVersion = getCargoPackageVersion(snapshot.cargoTomlRaw);
  const currentVersion = tauriConf.version;

  if (!parseSemver(currentVersion)) {
    throw new Error(`Current Tauri version "${currentVersion}" is not MAJOR.MINOR.PATCH.`);
  }

  if (packageJson.version !== currentVersion) {
    throw new Error(
      `package.json version (${packageJson.version}) does not match src-tauri/tauri.conf.json version (${currentVersion}).`,
    );
  }

  if (cargoVersion !== currentVersion) {
    throw new Error(
      `Cargo.toml version (${cargoVersion}) does not match src-tauri/tauri.conf.json version (${currentVersion}).`,
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`Current version: ${currentVersion}`);
    console.log('');
    console.log('How much to bump?');
    console.log('  1 = major (X.0.0)');
    console.log('  2 = minor (0.X.0)');
    console.log('  3 = patch (0.0.X)');
    console.log('  4 = set a specific version (MAJOR.MINOR.PATCH)');
    console.log('');

    const choice = (await rl.question('Choice [1-4]: ')).trim();
    let nextVersion = null;
    if (choice === '1') {
      nextVersion = bumpSemver(currentVersion, 'major');
    } else if (choice === '2') {
      nextVersion = bumpSemver(currentVersion, 'minor');
    } else if (choice === '3') {
      nextVersion = bumpSemver(currentVersion, 'patch');
    } else if (choice === '4') {
      const entered = (await rl.question('New version (MAJOR.MINOR.PATCH): ')).trim();
      nextVersion = parseSemver(entered) ? entered : null;
    } else {
      throw new Error('Enter 1, 2, 3, or 4.');
    }

    if (!nextVersion || nextVersion === currentVersion) {
      throw new Error('Could not compute a distinct MAJOR.MINOR.PATCH version.');
    }

    const gitTag = versionToGitTag(nextVersion);
    if (gitTagExists(gitTag)) {
      throw new Error(`Git tag "${gitTag}" already exists.`);
    }

    const releaseNotes = await readReleaseNotes(rl);
    packageJson.version = nextVersion;
    tauriConf.version = nextVersion;
    const cargoTomlUpdated = setCargoPackageVersion(snapshot.cargoTomlRaw, nextVersion);

    writeJson(packageJsonPath, packageJson);
    writeJson(tauriConfPath, tauriConf);
    writeFileSync(cargoTomlPath, cargoTomlUpdated, 'utf8');
    writeFileSync(releaseBodyPath, `${releaseNotes}\n`, 'utf8');

    try {
      runCargoGenerateLockfile();
      runProductionBuild();
    } catch (error) {
      restoreFiles(snapshot);
      throw error;
    }

    runGit([
      'add',
      'package.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      releaseBodyRelative,
    ]);
    runGit(['commit', '-m', `chore: bump version to ${nextVersion}`]);
    runGit(['tag', gitTag]);
    runGit(['push']);
    runGit(['push', 'origin', gitTag]);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error('[bump-tauri-version]', error);
  process.exit(1);
});
