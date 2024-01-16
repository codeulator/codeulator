import os from 'os';
import type { Application } from 'vscode-automation';
import { PooledApplication } from './applicationPool';
import { SafeError } from './errors';

export class LiveShare {
    private static CONTINUE_AS_ANONYMOUS = '.monaco-button[title="Continue as anonymous"]';
    private static NOTIFICATIONS_ICON = '#status\\.notifications > a';
    private static NOTIFICATIONS_VISIBLE = '.notifications-center.visible';
    private static NOTIFICATION_JOINING = '.monaco-list-row[aria-label^="Joining collaboration session"]';
    private static NOTIFICATION_SIGN_IN = '.monaco-list-row[aria-label^="Sign in with VS Live Share"]';
    private static STATUSBAR_ITEM = '.statusbar-item[id^="ms-vsliveshare.vsliveshare"]';

    app: Application;

    constructor(app: Application) {
        this.app = app;
    }

    async join(name: string, url: string) {
        await this.waitForJoinAsAnonymous();
        await this.app.workbench.quickinput.type(name);
        await this.app.code.dispatchKeybinding('enter');
        await this.app.code.waitForElement(LiveShare.NOTIFICATION_JOINING);
        await this.app.workbench.quickinput.waitForQuickInputOpened();
        await this.app.workbench.quickinput.type(url);
        await this.app.code.dispatchKeybinding('enter');
    }

    protected async waitForJoinAsAnonymous() {
        await this.app.workbench.quickaccess.runCommand('liveshare.join');
        await this.app.code.waitForElement(LiveShare.CONTINUE_AS_ANONYMOUS);

        // Lab notes:
        // - The notification and button are not clickable for some reason
        // - Button is "hovered" (inline style change) but not "focused" when you tab to it
        // - Other notifications can appear (affects pressing tab)

        // Options:
        // 1. Press tab 3 times, then enter. This breaks if other notifications appear.
        // 2. Press tab until the style change is detected, then enter. Kinda finicky.
        // 3. Click notifications icon in status bar, press down key until correct one
        //    has .focused, then press tab. This is implemented below.

        await this.app.code.waitAndClick(LiveShare.NOTIFICATIONS_ICON);
        await this.app.code.waitForElement(LiveShare.NOTIFICATIONS_VISIBLE);

        let found = false;

        for (let i = 0; i < 10; i++) {
            try {
                await this.app.code.waitForElement(
                    LiveShare.NOTIFICATION_SIGN_IN,
                    (el) => el.className == 'monaco-list-row focused',
                    1
                );
                found = true;
            } catch {}

            if (found) {
                break;
            }

            await this.app.code.dispatchKeybinding('ArrowDown');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (!found) {
            throw new Error('Could not find notification');
        }

        // Tab to "Continue as anonymous" and press enter
        await this.app.code.dispatchKeybinding('Tab');
        await this.app.code.dispatchKeybinding('enter');

        await this.app.workbench.quickinput.waitForQuickInputOpened();
    }

    async waitForReadWriteAccess(retryCount = 1000) {
        let seen = 0;

        for (let i = 0; i < retryCount; i++) {
            if (this.app instanceof PooledApplication && this.app.fsproxy && !this.app.fsproxy.alive) {
                // If the session URL is invalid, the default workspace will be loaded,
                // which causes the extension to be deactivated.
                throw new SafeError(
                    'Invalid session URL. The URL may have expired, or the ' +
                        'user may have forgotten to enable anonymous guest access.'
                );
            }

            try {
                // Setting retryCount=1 means we only try once. Note that waitForElement waits
                // 100ms after each attempt, so we don't need to add our own delay here.
                const el = await this.app.code.waitForElement(
                    LiveShare.STATUSBAR_ITEM,
                    // textContent is:
                    // " Joined" when RW
                    // " Joined (Read-Only)" when RO
                    // " Shared" when we're the host
                    (el) => el && ['Joined', 'Shared'].includes(el.textContent.trim()),
                    1 // retryCount
                );
                seen++;
            } catch {}

            if (seen >= 2) {
                // If we reach this point, the element was found and we're done
                return;
            }
        }

        throw new Error('Exceeded retry count while waiting for read/write access');
    }

    async elevate(name: string) {
        // Wait for the Live Share explorer section
        await this.app.code.waitForElement('.pane-header[aria-label="Live Share Section"]');

        // Check expanded state
        let expanded = true;
        try {
            const el = await this.app.code.waitForElement(
                '.pane-header[aria-label="Live Share Section"]:not(.expanded)',
                undefined,
                1
            );
            expanded = false;
        } catch {}

        // Expand if necessary
        if (!expanded) {
            await this.app.code.waitAndClick('.pane-header[aria-label="Live Share Section"]');
        }

        // Simulate right-click to open context menu
        await this.app.code.waitAndClick(
            `.monaco-list[aria-label="Live Share"] .monaco-list-row[aria-label="${name} "]`
        );
        await this.app.code.dispatchKeybinding('Shift+F10');

        // Wait 100ms for the menu to appear
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Focus last item in the menu ("Make Read/Write") and press enter
        await this.sendKeystroke('"m"');
        await this.sendKeystroke('return');
    }

    private async sendKeystroke(key: string) {
        switch (os.platform()) {
            case 'darwin':
                const applescript = await import('applescript');
                await new Promise((resolve, reject) => {
                    applescript.execString(
                        `tell application "System Events" to tell application process "Visual Studio Code" to keystroke ${key}`,
                        (error: any) => {
                            if (error) {
                                reject(error);
                            } else {
                                resolve(null);
                            }
                        }
                    );
                });
                break;

            default:
                throw new Error('Not implemented');
        }
    }
}
