(function () {
  try {
    // Antseed should open dark by default every time a visitor enters/reloads.
    // The built-in Docusaurus switch still lets the user view light mode after load,
    // but old saved light preferences must not make first entry bright.
    localStorage.setItem('theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  }
})();
