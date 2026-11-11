/* Landing page enhancements: returning members see "Open My Cohort" instead of
   another purchase prompt. The page works fully without this script. */
(function () {
  'use strict';
  const SO = window.SO;
  SO.initFaq(document);
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-so-cta]');
    if (a) SO.track('landing_cta_clicked');
  });
  (async function () {
    const token = await SO.token();
    if (!token) return;
    let me;
    try { me = await SO.api('GET', 'me'); } catch { return; }
    if (!me.signed_in) return;
    const signin = document.querySelector('[data-so-signin]');
    if (me.enrolled && me.review_state !== 'approved') {
      // Paid, under review (or not approved): point to their status, never to another purchase.
      document.querySelectorAll('[data-so-cta], [data-so-signin]').forEach(a => {
        a.textContent = 'My enrollment';
        a.href = `${SO.base}/app/status`;
        a.removeAttribute('data-so-cta');
      });
      document.querySelectorAll('.price-detail, .price-deadline').forEach(el => { el.hidden = true; });
    } else if (me.enrolled && me.access && me.access.active) {
      if (signin) { signin.textContent = 'Open My Cohort'; signin.href = `${SO.base}/app`; }
      document.querySelectorAll('[data-so-cta]').forEach(a => {
        a.textContent = 'Open My Cohort';
        a.href = `${SO.base}/app`;
        a.removeAttribute('data-so-cta');
      });
      document.querySelectorAll('.price-detail, .price-deadline').forEach(el => { el.hidden = true; });
    } else if (signin) {
      signin.textContent = 'Account';
      signin.href = `${SO.base}/login`;
    }
  })();
})();
