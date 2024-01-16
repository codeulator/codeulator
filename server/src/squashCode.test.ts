import { squashCode } from './squashCode';

describe('squashCode function', () => {
    it('should squash JavaScript statements', () => {
        const filename = 'test.js';
        const inputLines = [
            'let x = 1;',
            'console.log(x);',
            'if (x > 0) {',
            '  console.log("Positive number.");',
            '}',
        ];

        const expectedOutput = ['...', '...', 'if ... {', '  ...', '}'];

        expect(squashCode(filename, inputLines)).toEqual(expectedOutput);
    });

    it('should squash Python statements', () => {
        const filename = 'test.py';
        const inputLines = [
            '"""',
            'This is a comment',
            '"""',
            'from django.forms.widgets import (',
            '    HiddenInput,',
            '    MultipleHiddenInput',
            ')',
            '',
            'from itertools import chain',
            'x = 1',
            'print(x)',
            'if x > 0:',
            '    print("Positive number.")',
        ];

        const expectedOutput = [
            '...',
            '...',
            '...',
            'from django.forms.widgets import (',
            '    HiddenInput,',
            '    MultipleHiddenInput',
            ')',
            '',
            'from itertools import chain',
            '...',
            '...',
            'if x > 0:',
            '    ...',
        ];

        expect(squashCode(filename, inputLines)).toEqual(expectedOutput);
    });
});
