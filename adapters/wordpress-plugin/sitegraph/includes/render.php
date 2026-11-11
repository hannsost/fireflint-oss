<?php
/**
 * Server-side rendering of SiteGraph content (WP1.9).
 *
 * Renders HTML on the server so content is crawlable (SEO) and works without
 * JavaScript. The first scalar field of each item is treated as its title; the
 * remaining scalar fields are listed below. All output is escaped (§19).
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * @param string $channel Channel slug.
 * @param string $module  Content type key.
 * @return string Safe HTML.
 */
function sitegraph_render_content($channel, $module) {
    $data  = SiteGraph_Client::fetch($channel, $module);
    $items = (isset($data['items']) && is_array($data['items'])) ? $data['items'] : [];

    $out = '';

    if (!empty($data['error']) && $data['error'] === 'not_configured') {
        return '<div class="sitegraph-empty">SiteGraph ist noch nicht konfiguriert (API-URL und Token unter Einstellungen → SiteGraph).</div>';
    }

    if (!empty($data['_stale'])) {
        $out .= '<div class="sitegraph-stale-note">Live nicht erreichbar – zuletzt bekannte Version.</div>';
    }

    if (empty($items)) {
        return $out . '<div class="sitegraph-empty">Keine Inhalte verfügbar.</div>';
    }

    $out .= '<div class="sitegraph-list" data-channel="' . esc_attr($channel) . '" data-module="' . esc_attr($module) . '">';
    foreach ($items as $item) {
        if (!is_array($item)) {
            continue;
        }
        $out .= '<div class="sitegraph-item">';
        $is_first = true;
        foreach ($item as $key => $value) {
            if (!is_scalar($value) || $value === '') {
                continue;
            }
            // Skip internal flags.
            if (is_string($key) && strpos($key, '_') === 0) {
                continue;
            }
            if ($is_first) {
                $out .= '<div class="sitegraph-title">' . esc_html((string) $value) . '</div>';
                $is_first = false;
            } else {
                $out .= '<div class="sitegraph-field sitegraph-field-' . esc_attr($key) . '">'
                    . esc_html((string) $value) . '</div>';
            }
        }
        $out .= '</div>';
    }
    $out .= '</div>';

    return $out;
}
