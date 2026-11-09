/*
 * A white theme for /docs. Swagger UI is light already, but browsers that force dark mode (Chrome's Auto Dark Mode,
 * the Dark Reader extension) repaint it dark, and its example and response boxes are dark even in the light theme.
 */

/** Meta tags put at the top of <head> on the Swagger page: opt out of forced dark mode. */
export const LIGHT_ONLY_META =
  '<meta name="color-scheme" content="light only"><meta name="darkreader-lock">'

/** Served as /docs/static/theme/light.css. */
export const LIGHT_THEME_CSS = `
:root { color-scheme: light only; }
html, body { background: #ffffff; color: #1f2328; }
.swagger-ui, .swagger-ui .info .title, .swagger-ui .opblock-tag, .swagger-ui table thead tr td,
.swagger-ui table thead tr th, .swagger-ui .parameter__name, .swagger-ui .response-col_status,
.swagger-ui .model-title, .swagger-ui .model, .swagger-ui section.models h4 { color: #1f2328; }
.swagger-ui .scheme-container { background: #ffffff; box-shadow: none; border-bottom: 1px solid #e5e7eb; }
.swagger-ui section.models, .swagger-ui section.models.is-open h4 { border-color: #e5e7eb; }
.swagger-ui section.models .model-container { background: #f8fafc; }
.swagger-ui section.models .model-container:hover { background: #f1f5f9; }
.swagger-ui .opblock .opblock-section-header { background: #f8fafc; box-shadow: none; }
.swagger-ui .opblock-body pre.microlight, .swagger-ui .highlight-code pre, .swagger-ui .microlight,
.swagger-ui .response-col_description pre, .swagger-ui .model-box pre {
  background: #f6f8fa !important; color: #1f2328 !important; border: 1px solid #e5e7eb; border-radius: 6px;
}
.swagger-ui .copy-to-clipboard { background: #e5e7eb; }
.swagger-ui .copy-to-clipboard button { filter: invert(1); }
.swagger-ui input[type=text], .swagger-ui input[type=password], .swagger-ui textarea, .swagger-ui select {
  background: #ffffff; color: #1f2328; border: 1px solid #d0d7de;
}
.swagger-ui textarea.curl { background: #f6f8fa; color: #1f2328; }
`
