import * as assert from 'assert';
import * as vscode from 'vscode';

import { Client } from '../../client';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('type function', async () => {
        const testCases = [
            {
                text: 'foo<End>bar',
                expectedKeys: ['f', 'o', 'o', '<End>', 'b', 'a', 'r'],
            },
            {
                text: '<a></a>',
                expectedKeys: ['<', 'a', '>', '<', '/', 'a', '>'],
            },
            {
                text: '<<a><a><><<End>a',
                expectedKeys: ['<', '<', 'a', '>', '<', 'a', '>', '<', '>', '<', '<End>', 'a'],
            },
        ];

        const client = new Client();
        for (const tc of testCases) {
            let typedKeys: string[] = [];
            await client.type(tc.text, async (key) => {
                typedKeys.push(key);
            });
            assert.equal(typedKeys, tc.expectedKeys);
        }
    });
});
