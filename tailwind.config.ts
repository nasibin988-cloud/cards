import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        persian: {
          50:  '#f0edf2',
          100: '#ddd6e4',
          200: '#c2b5d1',
          300: '#a08db8',
          400: '#7d6699',
          500: '#65497f',
          600: '#543b6b',
          700: '#462f5a',
          800: '#3a2549',
          900: '#2d1b3a',
          950: '#1a0f24',
        },
        crimson: {
          50:  '#f5eced',
          100: '#e6d0d3',
          200: '#d1a8ae',
          300: '#b87d85',
          400: '#9e5862',
          500: '#8c3a47',
          600: '#76303c',
          700: '#612733',
          800: '#4e1f2b',
          900: '#3d1722',
          950: '#270d15',
        },
        saffron: {
          50:  '#f5f0e5',
          100: '#e8dcc5',
          200: '#d4c09c',
          300: '#bfa272',
          400: '#a8874f',
          500: '#8f7240',
          600: '#785f36',
          700: '#624d2d',
          800: '#4e3d25',
          900: '#3d301d',
          950: '#261e12',
        },
        dark: {
          50:  '#e8e7eb',
          100: '#d0ced6',
          200: '#a9a6b3',
          300: '#837f90',
          400: '#635f72',
          500: '#4d4959',
          600: '#3d3a48',
          700: '#302d3a',
          800: '#25222e',
          900: '#1a1722',
          925: '#13111a',
          950: '#0d0b12',
        },
      },
      fontFamily: {
        sans: [
          'var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display',
          'Segoe UI', 'Roboto', 'Helvetica Neue', 'sans-serif',
        ],
        farsi: [
          'var(--font-vazirmatn)', 'IRANSans', 'Tahoma', 'Arial', 'sans-serif',
        ],
        display: [
          'var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display',
          'sans-serif',
        ],
        mono: ['var(--font-mono)', 'SF Mono', 'Fira Code', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.65rem', { lineHeight: '1rem' }],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'glass-gradient': 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255,255,255,0.05)',
        'glass-lg': '0 16px 48px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255,255,255,0.06)',
        'glow': '0 0 20px rgba(101, 73, 127, 0.15)',
        'glow-lg': '0 0 40px rgba(101, 73, 127, 0.2)',
        'inner-light': 'inset 0 1px 0 rgba(255,255,255,0.08)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: 'none',
            lineHeight: '1.85',
          },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
export default config;
