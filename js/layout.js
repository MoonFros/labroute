const Layout = {
  // 1. Header Template
  renderHeader(activePage = 'home') {
    const navItems = [
      { id: 'home', label: 'Home', href: 'index.html' },
      { id: 'about', label: 'About', href: 'about.html' },
      { id: 'reports', label: 'Reports', href: 'report.html' },
      { id: 'donate', label: 'Donate', href: 'donate.html' },
      { id: 'suggest', label: 'Suggest', href: 'index.html#Suggest' },
      { id: 'others', label: 'Others', href: 'others.html' }
    ];


    const navLinksHTML = navItems
      .map(
        (item) => `
        <li>
          <a href="${item.href}" class="nav-link ${activePage === item.id ? 'active' : ''}">
            ${item.label}
          </a>
        </li>`
      )
      .join('');

    return `
      <div class="container header-container">
        <a href="index.html" class="brand-logo" aria-label="LabRoute Home">
          <span class="material-symbols-outlined">experiment</span>
          <span>LabRoute</span>
        </a>

        <nav aria-label="Main Navigation">
          <ul class="nav-menu" id="navMenu">
            ${navLinksHTML}
          </ul>
        </nav>

        <div class="header-actions">
          <form class="input-search-wrapper" id="navSearchForm" role="search">
            <button type="submit" class="search-btn-icon" aria-label="Submit search">
              <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </button>
            <input type="search" class="input-search-nav" placeholder="Search resources..." id="navSearch" autocomplete="off" />
          </form>

          <button class="icon-btn" id="themeToggleBtn" aria-label="Toggle light/dark theme"     title="Toggle theme">
            <span class="material-symbols-outlined" id="themeIcon">dark_mode</span>
          </button>

          <button class="mobile-toggle" id="mobileToggle" aria-label="Toggle navigation menu">
            <span class="material-symbols-outlined">menu</span>
          </button>
          </button>
        </div>
      </div>
    `;
  },

  // 2. Footer Template
  renderFooter() {
    const currentYear = new Date().getFullYear();
    return `
      <div class="container footer-container">
        <div class="footer-left">
          <a href="index.html" class="brand-logo" aria-label="LabRoute Home">
            <span class="material-symbols-outlined">experiment</span>
            <span>LabRoute</span>
          </a>
          
        </div>

        <ul class="footer-links">
          <li><a href="#ethics">Research Ethics</a></li>
          <li><a href="#privacy">Privacy Policy</a></li>
        </ul>

        <p>&copy; ${currentYear} LabRoute Institutional Repository. All Rights Reserved.</p>
      </div>
    `;
  },

  // 3. Initialize & Mount
  init() {
    const activePage = document.body.dataset.page || 'home';

    const headerElement = document.getElementById('site-header');
    if (headerElement) {
      headerElement.className = 'site-header';
      headerElement.innerHTML = this.renderHeader(activePage);
    }

    const footerElement = document.getElementById('site-footer');
    if (footerElement) {
      footerElement.className = 'site-footer';
      footerElement.innerHTML = this.renderFooter();
    }

    this.bindEvents();
  },

  // 4. Attach Interactions
  bindEvents() {
    // Global Header Search Controller
    const navSearchForm = document.getElementById('navSearchForm');
    const navSearch = document.getElementById('navSearch');

    const executeNavSearch = () => {
      if (!navSearch) return;
      const query = navSearch.value.trim();
      if (!query) return;

      const isHome = document.body.dataset.page === 'home';
      if (isHome) {
        // If already on homepage, update search box and filter live
        const mainSearch = document.getElementById('reportSearchInput');
        if (mainSearch) {
          mainSearch.value = query;
          mainSearch.dispatchEvent(new Event('input'));
          document.getElementById('Reports')?.scrollIntoView({ behavior: 'smooth' });
        }
      } else {
        // If on another page (about, others, report, etc.), redirect to home search
        window.location.href = `index.html?search=${encodeURIComponent(query)}#Reports`;
      }
    };

    if (navSearchForm) {
      navSearchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        executeNavSearch();
      });
    }

    if (navSearch) {
      navSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          executeNavSearch();
        }
      });
    }


    // Theme Switcher Controller with LocalStorage Persistence
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const themeIcon = document.getElementById('themeIcon');

    // 1. Sync theme state on load
    const currentTheme = localStorage.getItem('myela_theme') || 'light';
    if (currentTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (themeIcon) themeIcon.textContent = 'light_mode';
    }

    // 2. Toggle on click
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const newTheme = isDark ? 'light' : 'dark';

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('myela_theme', newTheme);

        if (themeIcon) {
          themeIcon.textContent = newTheme === 'dark' ? 'light_mode' : 'dark_mode';
        }
      });
    }

    // Mobile Drawer Toggle
    const mobileToggle = document.getElementById('mobileToggle');
    const navMenu = document.getElementById('navMenu');
    if (mobileToggle && navMenu) {
      mobileToggle.addEventListener('click', () => {
        navMenu.classList.toggle('open');
      });
    }

    // Scroll Glassmorphism Effect
    const siteHeader = document.getElementById('site-header');
    if (siteHeader) {
      window.addEventListener('scroll', () => {
        if (window.scrollY > 40) {
          siteHeader.classList.add('scrolled');
        } else {
          siteHeader.classList.remove('scrolled');
        }
      });
    }
  }
};

// Automatically mount when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  Layout.init();
});

window.addEventListener('load', () => {
  if (window.location.hash) {
    const target = document.querySelector(window.location.hash);
    if (target) {
      // Small timeout ensures the DOM has completely settled
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }
});
