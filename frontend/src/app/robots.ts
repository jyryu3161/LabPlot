import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
      },
      {
        userAgent: [
          'Amazonbot',
          'Applebot-Extended',
          'Bytespider',
          'CCBot',
          'ClaudeBot',
          'CloudflareBrowserRenderingCrawler',
          'Google-Extended',
          'GPTBot',
          'meta-externalagent',
        ],
        disallow: '/',
      },
    ],
    sitemap: 'https://labplotai.com/sitemap.xml',
  };
}
