import { indent, getKeystrokes } from './edit';

describe('indent', () => {
    it('correctly indents text', async () => {
        expect(
            indent(
                "words = re.split('[ -]', words)\nreturn ''.join(word[0].upper() for word in words if word)",
                4
            )
        ).toEqual(
            "words = re.split('[ -]', words)\n<Esc>i    return ''.join(word[0].upper() for word in words if word)"
        );
    });
});

describe('getKeystrokes', () => {
    it('uses correct indentation when replacing text', async () => {
        expect(
            getKeystrokes(
                [
                    {
                        op: 'replace',
                        order: 1,
                        params: {
                            anchorText: 'return',
                            newCode: 'return\nreturn',
                            indentSpaces: 4,
                        },
                    },
                ],
                ''
            )
        ).toEqual('gg/return\n6xareturn\n<Esc>i    return<Esc>');

        expect(
            getKeystrokes(
                [
                    {
                        op: 'replace',
                        order: 1,
                        params: {
                            anchorText: 'pass',
                            newCode:
                                "words = re.split('[ -]', words)\nreturn ''.join(word[0].upper() for word in words if word)",
                            relativePosition: 'before',
                            indentSpaces: 4,
                            indentTabs: 0,
                        },
                    },
                ],
                ''
            )
        ).toEqual(
            "gg/pass\n4xawords = re.split('[ -]', words)\n<Esc>i    return ''.join(word[0].upper() for word in words if word)<Esc>"
        );
    });
});
