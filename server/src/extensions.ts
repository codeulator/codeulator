import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ApplicationOptions } from 'vscode-automation';

export async function installExtension(id: string, appOptions: ApplicationOptions) {
    var cliPath: string;
    switch (os.platform()) {
        case 'darwin':
            cliPath = 'Contents/Resources/app/bin/code';
            break;
        default:
            cliPath = 'bin/code';
            break;
    }

    return new Promise((resolve, reject) => {
        const args = [
            '--user-data-dir', // required when running as root
            appOptions.userDataDir,
            '--extensions-dir',
            appOptions.extensionsPath,
            '--install-extension',
            id,
        ];

        const command = path.resolve(appOptions.codePath, cliPath);
        const process = spawn(command, args);
        process.on('error', reject);
        process.on('close', (code) => {
            if (code == 0) {
                resolve(null);
            } else {
                reject(`"${command}" ${args.join(' ')} exited with code ${code}`);
            }
        });
    });
}
