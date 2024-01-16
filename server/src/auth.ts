import { SafeError } from './errors';

export const defaultBaseUrl = 'https://auth.codeulator.com';

export async function verifyToken(token: string, { baseUrl = defaultBaseUrl } = {}) {
    const response = await fetch(new URL('/api/verify', baseUrl), {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
    });

    if (response.status >= 400) {
        throw new SafeError({
            message: 'Invalid auth token. Please reinstall the plugin.',
            status: 400,
            cause: new Error(
                `Auth server responded with ${response.status} ${response.statusText}. ` +
                    `Response body: ${await response.text()}`
            ),
        });
    }

    return (await response.json()) as { user_id: string };
}
