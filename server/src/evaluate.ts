import { Configuration, OpenAIApi } from 'openai';

let openai: OpenAIApi | undefined;

if (process.env.OPENAI_API_KEY) {
    const configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
    });
    openai = new OpenAIApi(configuration);
} else {
    console.warn("evaluatePatch will be skipped because OPENAI_API_KEY isn't set");
}

export async function evaluatePatch(patch: string, model = 'gpt-3.5-turbo'): Promise<string | null> {
    if (!openai) {
        console.debug('evaluatePatch is being skipped');
        return null;
    }

    const prompt = `Check this patch for mistakes.
Added lines have a + prefix, deleted lines have a - prefix, unchanged lines have no prefix.
Respond with a brief sentence identifying relevant issue(s), composed from this list:
- Unbalanced braces
- Unbalanced parenthesis
- Unterminated string
- Syntax error detected
- Imports added in inappropriate location
- Unreachable code (e.g. after a return statement)
- Code added in a location likely to cause problems
- Added code contains an obvious mistake
- New lines not indented optimally
- Obsolete code or "pass" not deleted
- Obsolete comment(s) or TODOs not deleted
Don't elaborate. If none of these issues are found, respond with "OK".

${patch}`;

    const response = await openai.createChatCompletion({
        model,
        messages: [
            { role: 'system', content: 'You are an experienced software engineer.' },
            { role: 'user', content: prompt },
        ],
    });

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Unexpected response from OpenAI API');
    } else if (content.includes('OK')) {
        return null;
    } else {
        return content;
    }
}
