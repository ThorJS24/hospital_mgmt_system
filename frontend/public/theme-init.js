/* Applies the saved (or system) colour theme before the first paint. External file so the CSP can forbid inline scripts. */
/* eslint-env browser */
try {
  const saved = localStorage.getItem('medicore-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch {
  /* storage can be unavailable (private mode); the default light theme is fine */
}
