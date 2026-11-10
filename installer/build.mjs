// Builds build/dist/AIChatSetup.exe: a Windows installer for the Claude Chat helper.
// Requires a built MCP package (npm run build --workspace=easyeda-copilot-mcp) and Node.js with --build-sea.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const mcpDir = join(root, 'mcp');
const outDir = join(root, 'build', 'dist');
const staging = join(tmpdir(), 'easyeda-copilot-installer');
const appDir = join(staging, 'app');

if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
if (!existsSync(join(mcpDir, 'dist', 'index.js'))) {
    throw new Error('mcp/dist is missing. Run: npm run build --workspace=easyeda-copilot-mcp');
}

const mcpPackage = JSON.parse(readFileSync(join(mcpDir, 'package.json'), 'utf8'));

// Pin runtime dependencies to the versions installed (and tested) in this checkout.
const dependencies = {};
for (const name of Object.keys(mcpPackage.dependencies)) {
    const installed = [join(mcpDir, 'node_modules', name), join(root, 'node_modules', name)]
        .map(dir => join(dir, 'package.json'))
        .find(existsSync);
    dependencies[name] = installed ? JSON.parse(readFileSync(installed, 'utf8')).version : mcpPackage.dependencies[name];
}

console.log('Staging app files...');
rmSync(staging, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: mcpPackage.name,
    version: mcpPackage.version,
    type: mcpPackage.type,
    private: true,
    ...(mcpPackage.easyedaCopilotDocs ? { easyedaCopilotDocs: mcpPackage.easyedaCopilotDocs } : {}),
    dependencies,
}, null, 2));
cpSync(join(mcpDir, 'dist'), join(appDir, 'dist'), { recursive: true });
cpSync(join(mcpDir, 'docs'), join(appDir, 'docs'), { recursive: true });
cpSync(join(mcpDir, 'LICENSE'), join(appDir, 'LICENSE'));

console.log('Installing runtime dependencies...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--no-package-lock'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: true,
});

// Only the Windows native binaries are needed.
function prune(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.bin') rmSync(file, { recursive: true, force: true });
            else prune(file);
        } else if (/\.(darwin|linux)-[\w-]+\.node$/.test(entry.name)) {
            rmSync(file, { force: true });
        }
    }
}
prune(join(appDir, 'node_modules'));

console.log('Packing...');
const chunks = [];
let fileCount = 0;
function pack(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) { pack(file); continue; }
        if (!entry.isFile()) continue;
        const name = Buffer.from(relative(staging, file).split(sep).join('/'), 'utf8');
        const data = readFileSync(file);
        const header = Buffer.alloc(8 + name.length);
        header.writeUInt32LE(name.length, 0);
        name.copy(header, 4);
        header.writeUInt32LE(data.length, 4 + name.length);
        chunks.push(header, data);
        fileCount += 1;
    }
}
pack(appDir);
const payload = gzipSync(Buffer.concat(chunks), { level: 9 });
const payloadPath = join(staging, 'app.pack.gz');
writeFileSync(payloadPath, payload);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const versionPath = join(staging, 'version.txt');
writeFileSync(versionPath, `${mcpPackage.version}-${stamp}`);
console.log(`Payload: ${fileCount} files, ${(payload.length / 1e6).toFixed(1)} MB compressed`);

mkdirSync(outDir, { recursive: true });
const output = join(outDir, 'AIChatSetup.exe');
const seaConfig = join(staging, 'sea.json');
writeFileSync(seaConfig, JSON.stringify({
    main: join(here, 'main.cjs'),
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { 'app.pack.gz': payloadPath, 'version.txt': versionPath },
}, null, 2));
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
console.log(`Installer: ${output} (${(statSync(output).size / 1e6).toFixed(1)} MB)`);
