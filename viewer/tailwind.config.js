/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "app-primary": "#ff914d",
        "app-secondary": "#7c442d",
        "app-text": "#ecf2f8",
        "app-background": "#020e1d",
        "app-accent": "#a48990",
        "app-card": "#0b1a2e",
        "app-muted": "#94a3b8",
      },
    },
  },
  plugins: [],
};
