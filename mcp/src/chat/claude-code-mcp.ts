import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeMcpAdd, claudeMcpRemove, findClaude } from './claude-cli';

/** Name of the entry in the user's Claude Code; differs from upstream's "easyeda-copilot" so neither replaces the other. */
export const CLAUDE_CODE_MCP_NAME = 'easyeda-ai-assistant';
const MARKER_FILE = 'claude-code-mcp.json';

async function readMarker(stateDir: string): Promise<string | undefined> {
    try {
        const name = JSON.parse(await readFile(join(stateDir, MARKER_FILE), 'utf8')).name;
        return typeof name === 'string' ? name : undefined;
    } catch {
        return undefined;
    }
}

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
    // An earlier install may have used another name; only an entry we added is removed.
    const previous = await readMarker(stateDir);
    if (previous && previous !== CLAUDE_CODE_MCP_NAME) await claudeMcpRemove(claude, previous);
    await claudeMcpAdd(claude, CLAUDE_CODE_MCP_NAME, command);
    // Remembers that this entry is ours, so uninstalling does not remove one the user added.
    await writeFile(join(stateDir, MARKER_FILE), JSON.stringify({ name: CLAUDE_CODE_MCP_NAME, command }, null, 2));
    return command;
}

/** Removes the entry added by registerClaudeCodeMcp. Returns whether one was removed. */
export async function unregisterClaudeCodeMcp(stateDir: string) {
    const name = await readMarker(stateDir);
    if (!name) return false;
    await rm(join(stateDir, MARKER_FILE), { force: true });
    const claude = findClaude();
    return claude ? claudeMcpRemove(claude, name) : false;
}
