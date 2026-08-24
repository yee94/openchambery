import tailwindcss from '@tailwindcss/postcss';
import dptFontSize from './scripts/postcss-dpt-font-size.mjs';

export default {
  plugins: [tailwindcss, dptFontSize],
}