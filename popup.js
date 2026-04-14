document.addEventListener('DOMContentLoaded', () => {
    const githubBtn = document.querySelector('.github-btn');
    
    githubBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const url = githubBtn.getAttribute('href');
        
        // Use the browser/chrome polyfill to open a new tab
        if (typeof browser !== 'undefined' && browser.tabs) {
            browser.tabs.create({ url: url });
        } else if (typeof chrome !== 'undefined' && chrome.tabs) {
            chrome.tabs.create({ url: url });
        } else {
            window.open(url, '_blank');
        }
    });
});
