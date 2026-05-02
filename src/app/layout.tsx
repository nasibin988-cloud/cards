import type { Metadata, Viewport } from 'next';
import { Inter, Vazirmatn, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import AppShell from '@/components/AppShell';
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration';
import { withBasePath } from '@/lib/basePath';

// Self-hosted at build time (next/font/google), so the app keeps its
// typography offline as well as on. No CDN at runtime.
const inter = Inter({
  subsets: ['latin'],
  weight: ['200', '300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

const vazirmatn = Vazirmatn({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-vazirmatn',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Cards',
  description: 'Spaced-repetition study, offline-first.',
  manifest: withBasePath('/manifest.json'),
  applicationName: 'Cards',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Cards',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: '#0d0b12',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${vazirmatn.variable} ${jetbrainsMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body className="dark">
        <AppShell>{children}</AppShell>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
