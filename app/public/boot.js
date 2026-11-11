'use strict';
/* 首屏前应用明暗主题与主题色（同步加载于 <head>，避免页面先以默认配色闪现） */
(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem('bc.theme');
    if (t === 'light' || t === 'dark') d.dataset.theme = t;
    var a = localStorage.getItem('bc.accent');
    if (a === 'indigo' || a === 'violet' || a === 'teal' || a === 'graphite') d.dataset.accent = a;
  } catch (e) { /* 隐私模式等无法读取本地存储时使用默认配色 */ }
})();
