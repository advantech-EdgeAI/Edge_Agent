// Minimal Markdown -> HTML for chat answers (bold, italic, inline code, code blocks, headings,
// bulleted/numbered lists, rules, paragraphs). No external library: the page must work offline.
//
// Input must ALREADY be HTML-escaped - the server's escape_html() (history text) or grid.js's
// escapeHTML() (live streamed text) - so every '<' '>' '&' '"' "'" in the model's output is an
// entity and the only raw tag present is the '<br/>' those escapers use for newlines. This
// function only ever adds its own fixed tags around that escaped text, so model output can
// never inject HTML through it.

function renderMarkdownInline(text) {
  // inline code first, so '*' or '_' inside `...` is left alone
  return text.split(/(`[^`]+`)/).map(function(part) {
    if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`')
      return '<code>' + part.slice(1, -1) + '</code>';
    return part
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  }).join('');
}

function renderMarkdown(escaped) {
  const lines = String(escaped).replace(/<br\/>/g, '\n').split('\n');
  const out = [];
  let paragraph = [];     // consecutive plain lines, joined with <br/>
  let list = null;        // {tag: 'ul'|'ol', items: []}
  let code = null;        // lines inside a ``` fence

  function flushParagraph() {
    if (paragraph.length) out.push('<p>' + paragraph.map(renderMarkdownInline).join('<br/>') + '</p>');
    paragraph = [];
  }
  function flushList() {
    if (list) out.push(`<${list.tag}>` + list.items.map(i => '<li>' + renderMarkdownInline(i) + '</li>').join('') + `</${list.tag}>`);
    list = null;
  }

  for (const line of lines) {
    if (code !== null) {
      if (/^\s*```/.test(line)) {
        out.push('<pre class="md-code"><code>' + code.join('\n') + '</code></pre>');
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph(); flushList();
      code = [];
      continue;
    }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      flushParagraph(); flushList();
      out.push('<div class="md-heading">' + renderMarkdownInline(m[2]) + '</div>');
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(); flushList();
      out.push('<hr class="md-rule">');
    } else if ((m = line.match(/^\s*[-*•+]\s+(.*)$/))) {
      flushParagraph();
      if (!list || list.tag !== 'ul') { flushList(); list = {tag: 'ul', items: []}; }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      if (!list || list.tag !== 'ol') { flushList(); list = {tag: 'ol', items: []}; }
      list.items.push(m[1]);
    } else if (line.trim() === '') {
      flushParagraph(); flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  if (code !== null) out.push('<pre class="md-code"><code>' + code.join('\n') + '</code></pre>');  // unclosed fence while streaming
  flushParagraph(); flushList();
  return out.join('');
}

if (typeof module !== 'undefined') module.exports = {renderMarkdown};
