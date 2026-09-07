const Layout = {
    // 1. Header Template
    renderHeader(activePage = 'home') {
        const navItems = [
            { id: 'home', label: 'Home', href: 'index.html' },
            { id: 'about', label: 'About', href: 'about.html' },
            { id: 'reports', label: 'Reports', href: 'report.html' },
            { id: 'donate', label: 'Donate', href: 'donate.html' },
            { id: 'suggest', label: 'Suggest', href: 'index.html#Suggest' }
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
          <div class="input-search-wrapper">
            <span class="material-symbols-outlined search-icon search-icon">search</span>
            <input type="text" class="input-search-nav" placeholder="Search reports..." id="navSearch" />
          </div>

          <button class="icon-btn" aria-label="Settings">
            <span class="material-symbols-outlined">settings</span>
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
          <p>&copy; ${currentYear} LabRoute Institutional Repository. All Rights Reserved.</p>
        </div>

        <ul class="footer-links">
          <li><a href="#ethics">Research Ethics</a></li>
          <li><a href="#licensing">Institutional Licensing</a></li>
          <li><a href="#privacy">Privacy Policy</a></li>
          <li><a href="#governance">Data Governance</a></li>
        </ul>
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
