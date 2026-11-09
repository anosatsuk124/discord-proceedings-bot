// HTML に埋め込まれた本文を操作するだけで、通信はしない。無効でも内容は失われない。
(() => {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];
    const tools = $('#tools');
    if (!tools) return;
    tools.hidden = false;
    tools.addEventListener('submit', (e) => e.preventDefault());

    const q = $('#q');
    const count = $('#count');
    const turns = $$('.log > li').map((el) => ({
        el,
        s: el.dataset.s,
        text: el.textContent.toLowerCase(),
    }));
    const chapters = $$('#transcript > section');
    const muted = new Set();
    let hits = [];
    let at = -1;

    const mark = (term) => {
        if (!window.Highlight) return;
        CSS.highlights.delete('hit');
        if (!term) return;
        const ranges = [];
        for (const { el } of hits) {
            const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            while (walk.nextNode()) {
                const n = walk.currentNode;
                const t = n.data.toLowerCase();
                for (
                    let i = t.indexOf(term);
                    i >= 0;
                    i = t.indexOf(term, i + term.length)
                ) {
                    const r = new Range();
                    r.setStart(n, i);
                    r.setEnd(n, i + term.length);
                    ranges.push(r);
                }
            }
        }
        CSS.highlights.set('hit', new Highlight(...ranges));
    };

    let origin = null;
    const apply = () => {
        const term = q.value.trim().toLowerCase();
        // 絞り込むとページが縮むので、検索を始めた位置を覚えておいて戻す。
        if (term && origin === null) origin = scrollY;
        hits = [];
        for (const t of turns) {
            const show = !muted.has(t.s) && (!term || t.text.includes(term));
            t.el.hidden = !show;
            if (show && term) hits.push(t);
        }
        for (const c of chapters) {
            c.hidden = !c.querySelector('.log > li:not([hidden])');
        }
        at = -1;
        count.textContent = term ? `${hits.length} 件 ( n で次へ )` : '';
        mark(term);
        if (!term && origin !== null) {
            scrollTo(0, origin);
            origin = null;
        }
    };

    const go = (step) => {
        if (!hits.length) return;
        at = (at + step + hits.length) % hits.length;
        hits[at].el.scrollIntoView({ block: 'center' });
        count.textContent = `${at + 1} / ${hits.length} 件`;
    };

    const chapterStep = (step) => {
        const visible = chapters.filter((c) => !c.hidden);
        const y = scrollY + 40;
        let i = visible.findIndex((c) => c.offsetTop > y);
        if (i < 0) i = visible.length;
        const target = visible[step > 0 ? i : i - 2];
        if (target) location.hash = target.id;
    };

    const toggleOriginals = () => {
        const all = $$('details.orig');
        const open = !all.some((d) => d.open);
        for (const d of all) d.open = open;
        $('#orig').textContent = open
            ? '原文をすべて閉じる( o )'
            : '原文をすべて開く( o )';
    };

    let timer;
    q.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(apply, 150);
    });
    for (const button of $$('#speakers button')) {
        button.setAttribute('aria-pressed', 'true');
        button.addEventListener('click', () => {
            const on = button.getAttribute('aria-pressed') !== 'true';
            button.setAttribute('aria-pressed', String(on));
            if (on) muted.delete(button.dataset.s);
            else muted.add(button.dataset.s);
            apply();
        });
    }
    $('#orig').addEventListener('click', toggleOriginals);

    addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.activeElement === q) {
            q.value = '';
            apply();
            q.blur();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input'))
            return;
        const action = {
            '/': () => q.focus(),
            n: () => go(1),
            N: () => go(-1),
            j: () => chapterStep(1),
            k: () => chapterStep(-1),
            o: toggleOriginals,
        }[e.key];
        if (action) {
            e.preventDefault();
            action();
        }
    });

    // 目次に現在の章を出す。
    const links = $$('#toc ol a');
    let pending = false;
    const track = () => {
        pending = false;
        const y = scrollY + 80;
        let current = -1;
        chapters.forEach((c, i) => {
            if (c.offsetTop <= y) current = i;
        });
        links.forEach((a, i) => {
            if (i === current)
                a.parentElement.setAttribute('aria-current', 'true');
            else a.parentElement.removeAttribute('aria-current');
        });
    };
    addEventListener(
        'scroll',
        () => {
            if (!pending) {
                pending = true;
                requestAnimationFrame(track);
            }
        },
        { passive: true }
    );
    track();
})();
