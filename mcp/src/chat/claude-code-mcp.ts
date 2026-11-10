import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeMcpAdd, claudeMcpRemove, findClaude } from './claude-cli';
import { MCP_SERVER_NAME } from './session';

const MARKER_FILE = 'claude-code-mcp.json';

/**
 * The command Claude Code runs for the MCP server. From an npx cache we go through
 * npx (the cache can be cleaned); otherwise this runtime runs the file itself.
 */
export function mcpServerCommand(entry: string): string[] {
    if (/[\\/]_npx[\\/]/.test(entry)) {
        const npx = ['npx', '-y', 'easyeda-copilot-mcp'];
        // npx is a .cmd shim on Windows and must go through cmd.exe.
        return process.platform === 'win32' ? ['cmd', '/c', ...npx] : npx;
    }
    return [process.execPath, entry];
}

/**
 * Makes the EasyEDA tools available in the user's own Claude Code sessions (terminal,
 * VS Code, desktop). Returns the registered command, or undefined without Claude Code.
 */
export async function registerClaudeCodeMcp(entry: string, stateDir: string) {
    const claude = findClaude();
    if (!claude) return undefined;
    const command = mcpServerCommand(entry);
    await claudeMcpAdd(claude, MCP_SERVER_NAME, command);
    // Remembers that this entry is ours, so uninstalling does not remove one the user added.
    await writeFile(join(stateDir, MARKER_FILE), JSON.stringify({ name: MCP_SERVER_NAME, command }, null, 2));
    return command;
}

/** Removes the entry added by registerClaudeCodeMcp. Returns whether one was removed. */
export async function unregisterClaudeCodeMcp(stateDir: string) {
    const marker = join(stateDir, MARKER_FILE);
    let name: string;
    try {
        name = JSON.parse(await readFile(marker, 'utf8')).name;
    } catch {
        return false;
    }
    await rm(marker, { force: true });
    const claude = findClaude();
    return claude && typeof name === 'string' ? claudeMcpRemove(claude, name) : false;
}
