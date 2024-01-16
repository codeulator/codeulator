class Client {
    static specialKeys = ['<Esc>', '<End>'];

    async type(text: string, executor: (key: string[1]) => Thenable<void>) {
        const typeSingleKey = async (text: string) => {
            // Don't type more than 1 key per 10ms
            await Promise.all([executor(text), new Promise((resolve) => setTimeout(resolve, 10, null))]);
        };

        const normalizeCase = (text: string) => {
            // Only capitalize the first letter after the opening bracket
            return text.replace(/<(.)/, (match, p1) => '<' + p1.toUpperCase());
        };

        const typeKeys = async (keys: string) => {
            for (let key of keys) {
                await typeSingleKey(key);
            }
        };

        // Determine the maximum length of special keys
        const maxKeyLength = Client.specialKeys.reduce((max, key) => Math.max(max, key.length), 0);

        let buffer = '';
        for (let char of text.replace('<Enter>', '\n')) {
            // Always reset on '<' to account for sequences like '<<Esc>'
            if (char === '<') {
                await typeKeys(buffer);
                buffer = '';
            }

            buffer += char;

            // If buffer size exceeds maximum special key length or if it doesn't start with '<',
            // flush out the buffer as normal characters.
            if (buffer.length > maxKeyLength || !buffer.startsWith('<')) {
                await typeKeys(buffer);
                buffer = '';
            } else if (char === '>') {
                const normalized = normalizeCase(buffer);
                if (Client.specialKeys.includes(normalized)) {
                    await typeSingleKey(normalized);
                    buffer = '';
                }
            }
        }

        // Handle any remaining characters in the buffer after the loop
        await typeKeys(buffer);
    }
}

describe('type function', () => {
    it('should type correctly', async () => {
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
            expect(typedKeys).toEqual(tc.expectedKeys);
        }
    });
});
