const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

async function generatePageMap($) {
  const pageMap = {
    title: $('title').text(),
    forms: [],
    links: [],
    buttons: [],
    inputs: [],
    structure: []
  };

  // Map forms
  $('form').each((i, form) => {
    const formInfo = {
      id: $(form).attr('id') || `form_${i}`,
      action: $(form).attr('action'),
      method: $(form).attr('method'),
      inputs: $(form).find('input, select, textarea').map((_, el) => ({
        type: $(el).attr('type') || el.tagName.toLowerCase(),
        name: $(el).attr('name'),
        id: $(el).attr('id'),
        placeholder: $(el).attr('placeholder')
      })).get()
    };
    pageMap.forms.push(formInfo);
  });

  // Map clickable elements
  $('a').each((i, link) => {
    pageMap.links.push({
      text: $(link).text().trim(),
      href: $(link).attr('href'),
      id: $(link).attr('id'),
      class: $(link).attr('class')
    });
  });

  $('button').each((i, button) => {
    pageMap.buttons.push({
      text: $(button).text().trim(),
      id: $(button).attr('id'),
      type: $(button).attr('type'),
      class: $(button).attr('class')
    });
  });

  // Map input fields
  $('input, select, textarea').each((i, input) => {
    if (!$(input).closest('form').length) {
      pageMap.inputs.push({
        type: $(input).attr('type') || input.tagName.toLowerCase(),
        name: $(input).attr('name'),
        id: $(input).attr('id'),
        placeholder: $(input).attr('placeholder')
      });
    }
  });

  // Generate simplified DOM structure
  function generateStructure(element) {
    const $el = $(element);
    const children = $el.children().map((_, child) => generateStructure(child)).get();
    
    return {
      tag: element.tagName.toLowerCase(),
      id: $el.attr('id') || undefined,
      class: $el.attr('class') || undefined,
      type: $el.attr('type') || undefined,
      text: $el.text().trim().substring(0, 100) || undefined,
      children: children.length ? children : undefined
    };
  }

  pageMap.structure = generateStructure($('body')[0]);

  return pageMap;
}

async function generateInteractiveView($) {
  const interactiveView = {
    inputs: [],
    buttons: [],
    links: [],
    textContent: []
  };

  // Find all interactive elements
  $('input, textarea, select').each((_, el) => {
    const $el = $(el);
    interactiveView.inputs.push({
      type: $el.attr('type') || el.tagName.toLowerCase(),
      selector: generateSelector($el),
      placeholder: $el.attr('placeholder'),
      value: $el.val(),
      label: findAssociatedLabel($el)
    });
  });

  $('button, [role="button"]').each((_, el) => {
    const $el = $(el);
    interactiveView.buttons.push({
      text: $el.text().trim(),
      selector: generateSelector($el),
      type: $el.attr('type'),
      disabled: $el.prop('disabled')
    });
  });

  $('a').each((_, el) => {
    const $el = $(el);
    interactiveView.links.push({
      text: $el.text().trim(),
      href: $el.attr('href'),
      selector: generateSelector($el)
    });
  });

  // Find meaningful text content (headers, paragraphs, lists)
  $('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text) {
      interactiveView.textContent.push({
        tag: el.tagName.toLowerCase(),
        text: text.substring(0, 150), // Limit text length
        selector: generateSelector($el)
      });
    }
  });

  return interactiveView;
}

// Helper function to generate a reliable CSS selector
function generateSelector($el) {
  const id = $el.attr('id');
  if (id) return `#${id}`;

  const tag = $el[0].tagName.toLowerCase();
  let selector = tag;
  
  const classes = $el.attr('class');
  if (classes) {
    selector += '.' + classes.split(/\s+/).join('.');
  }

  // Add attribute selectors for inputs
  if (tag === 'input') {
    const type = $el.attr('type');
    const name = $el.attr('name');
    if (type) selector += `[type="${type}"]`;
    if (name) selector += `[name="${name}"]`;
  }

  return selector;
}

// Helper function to find associated label for form elements
function findAssociatedLabel($el) {
  const id = $el.attr('id');
  if (id) {
    const label = $el.closest('form, body').find(`label[for="${id}"]`).text().trim();
    if (label) return label;
  }
  return $el.closest('label').text().trim() || null;
}

async function analyzePage(html) {
  const $ = cheerio.load(html, {
    decodeEntities: true,
    xmlMode: false
  });

  // Remove unwanted elements
  $('script').remove();
  $('style').remove();
  $('link[rel="stylesheet"]').remove();
  $('meta').remove();
  $('svg').remove();
  
  // Define whitelist of allowed attributes
  const allowedAttributes = new Set([
    'class', 'href', 'src', 'id', 'type', 'value', 'title',
    'alt', 'name', 'placeholder', 'role', 'aria-label',
    'target', 'rel', 'for', 'action', 'method'
  ]);

  // Clean all elements
  $('*').each((i, el) => {
    if (el.attribs) {
      Object.keys(el.attribs).forEach(attr => {
        if (!allowedAttributes.has(attr.toLowerCase())) {
          $(el).removeAttr(attr);
        }
      });
    }
  });

  // Get cleaned HTML and normalize whitespace
  let cleanedHtml = $.root().html()
    .replace(/^\s*[\r\n]/gm, '')
    .replace(/\s+$/gm, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n');
  // Generate page map
  const pageMap = await generatePageMap($);
  // Generate views (remove structure generation)
  const interactiveView = await generateInteractiveView($);

  // Save debug files
  await saveDebugFiles(cleanedHtml, {
    interactiveView,
    pageMap
  });

  return {
    html: cleanedHtml,
    interactive: interactiveView,
    pageMap: pageMap
  };
}

async function saveDebugFiles(cleanedHtml, analysisData) {
  const testDir = path.join(__dirname, 'test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Save all files with consistent naming pattern: type_timestamp.extension
  fs.writeFileSync(
    path.join(testDir, `page_${timestamp}.html`),
    cleanedHtml,
    'utf8'
  );

  fs.writeFileSync(
    path.join(testDir, `interactive_${timestamp}.json`),
    JSON.stringify(analysisData.interactiveView, null, 2),
    'utf8'
  );

  fs.writeFileSync(
    path.join(testDir, `map_${timestamp}.json`),
    JSON.stringify(analysisData.pageMap, null, 2),
    'utf8'
  );

  console.log(`Debug files saved with timestamp: ${timestamp}`);
  return timestamp;
}

module.exports = {
  analyzePage
}; 