module.exports = {
    trailingComma: 'es5',
    tabWidth: 4,
    singleQuote: true,
    printWidth: 110,
    overrides: [
        {
            files: ['*.yml', '*.yaml'],
            options: {
                tabWidth: 2,
            },
        },
    ],
};
