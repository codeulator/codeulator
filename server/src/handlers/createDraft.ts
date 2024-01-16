import type { Request, Response } from 'express';
import type { Uri } from 'vscode';

// jsdiff is vendored because pnpm doesn't install it correctly.
import { createPatch } from 'diff';

import type { Server, Draft } from '../server';
import { evaluatePatch } from '../evaluate';
import { dispatchKeys, getKeystrokes } from './edit';
import { SafeError, handleErrors } from '../errors';
import { FileType } from '../filesystem';

export default async function createDraft(this: Server, req: Request, res: Response) {
    const { path: filePath, operations = [], dependsOn = [], create, allowStaleEdits } = req.body;

    await handleErrors.bind(this)(req, res, async () => {
        const { lease, logger } = req;
        const app = lease.app;

        let fileContent = '';
        let exists = false;

        const uri = { scheme: 'file', path: filePath } as Uri;
        try {
            if ((await app.fsproxy.stat(uri)).type == FileType.File) {
                exists = true;
            }
        } catch (error) {}

        if ((exists || !create) && !allowStaleEdits) {
            // Refuse to write if the file wasn't read recently. This is to avoid a
            // situation where a file being written has been pushed outside of the
            // context window, which would lead to hallucinations.
            if (!lease.readHistory.includes(filePath)) {
                throw new SafeError(
                    "The part of the file you're trying to edit may have changed. Read that part again and retry."
                );
            }
            fileContent = new TextDecoder().decode(await app.fsproxy.readFile(uri));
        } else {
            // Create an empty file
            await app.fsproxy.writeFile(uri, new Uint8Array());
        }

        for (const op of operations) {
            //TODO: need to simulate applying the operations, in case anchorText is added
            if (op.anchorText && !fileContent.includes(op.anchorText)) {
                throw new SafeError({ message: 'Anchor text not found: ' + op.anchorText, sensitive: true });
            }
        }

        let oldContent = '';
        if (exists || !create) {
            // Open the file in the editor
            await this.openFile(app, this.normalizePath(filePath));

            oldContent = await app.fsproxy.getEditorText();
            logger.debug(`createDraft: oldContent is ${oldContent.length} bytes`);

            // Select all and copy to register `a`
            await dispatchKeys(app, 'ggVG"ay');
        }

        // Open a temporary editor and wait for focus
        await app.workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
        await app.code.waitForElement(
            '.tabs-container div.tab.active[aria-selected="true"][data-resource-name^="Untitled"]'
        );
        await app.code.waitForActiveElement('.editor-instance .monaco-editor[data-uri^="untitled"] textarea');

        if (exists || !create) {
            // Paste from register, and delete the extra line added when pasting
            await app.fsproxy.type('"apggdd');
        }

        const keystrokes = getKeystrokes(operations, fileContent);
        await app.fsproxy.type(keystrokes);

        //TODO: keystrokes take time to be processed by the editor. We should add a
        // canary keystroke or sequence and then use the extension to detect it.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const newContent = await app.fsproxy.getEditorText();
        logger.debug(`createDraft: newContent is ${newContent.length} bytes`);

        // Close the temporary editor
        await dispatchKeys(app, ':q!\n');

        let draft: Draft = { path: filePath, keystrokes, dependsOn, hasProblem: false };
        const draftID = (lease.drafts.size + 1).toString();
        lease.drafts.set(draftID, draft);

        let diff = createPatch(filePath, oldContent, newContent, undefined, undefined, {
            context: 4,
            ignoreWhitespace: false,
            newlineIsToken: false,
        });

        let code = 201;
        let result = '';

        try {
            let problem = await evaluatePatch(diff);
            if (problem) {
                code = 202;
                result += `WARNING: ${problem}\n\n`;
                draft.hasProblem = true;
            }
        } catch (error) {
            logger.warn('createDraft: evaluatePatch failed', { error });
        }

        result += `Draft ID: ${draftID}\n\n`;
        result += diff.split('\n').slice(2).join('\n');
        res.status(code).send(result);
    });
}
