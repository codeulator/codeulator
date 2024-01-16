import * as vscode from 'vscode';
import * as vsls from 'vsls';
import { Client } from './client';

let client: Client;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating fsproxy extension...');

    const port = process.env.SFD_PORT ? parseInt(process.env.SFD_PORT) : 3100;
    if (!process.env.SFD_PORT) {
        console.warn('SFD_PORT environment variable not set, using default port 3100');
    }

    client = new Client();
    client.start({
        fs: vscode.workspace.fs,
        applyEdit: vscode.workspace.applyEdit,
        extensionPath: context.extensionPath,
        webSocketURL: `ws://localhost:${port}/fsproxy`,
    });

    // Log VSLS events
    const api = await vsls.getApi();
    if (api && process.env.DEBUG) {
        api.onDidChangePeers((e) => {
            console.debug('onDidChangePeers:', JSON.stringify(e));
        });
        api.onDidChangeSession((e) => {
            console.debug('onDidChangeSession:', JSON.stringify(e));
        });
        if (api.onActivity) {
            api.onActivity((e) => {
                console.debug('onActivity:', JSON.stringify(e));
            });
        }
    }

    console.log('fsproxy extension activated!');
}

export function deactivate() {
    console.log('fsproxy extension deactivated');
    return client?.stop();
}
