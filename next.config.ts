import type { NextConfig } from 'next';
const config: NextConfig = {
    output: process.env.REGION_STANDALONE === 'true' ? 'standalone' : undefined,
    outputFileTracingIncludes: { '/version/**': ['./data/patches/*.json'] },
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    { key: 'Referrer-Policy', value: 'same-origin' },
                ],
            },
        ];
    },
};
export default config;
