<?php
/**
 * Plugin Name: SiteGraph
 * Description: Bindet zentral gepflegte Inhalte aus SiteGraph in WordPress ein (Shortcode + Block) – serverseitig gerendert, mit Cache und Ausfall-Fallback.
 * Version:     0.1.0
 * Author:      SiteGraph
 * License:     MIT
 * Requires PHP: 7.4
 *
 * WP1.9: thin adapter. The SaaS API stays the source of truth; this plugin only
 * pulls + caches. On API outage it serves the last known version (Whitepaper §13).
 */

if (!defined('ABSPATH')) {
    exit;
}

define('SITEGRAPH_VERSION', '0.1.0');
define('SITEGRAPH_DIR', plugin_dir_path(__FILE__));
define('SITEGRAPH_URL', plugin_dir_url(__FILE__));

require_once SITEGRAPH_DIR . 'includes/class-sitegraph-client.php';
require_once SITEGRAPH_DIR . 'includes/render.php';
require_once SITEGRAPH_DIR . 'includes/class-sitegraph-settings.php';

SiteGraph_Settings::init();

/** Register the (optional) frontend stylesheet. */
add_action('wp_enqueue_scripts', function () {
    wp_register_style('sitegraph', SITEGRAPH_URL . 'assets/sitegraph.css', [], SITEGRAPH_VERSION);
});

/**
 * Shortcode: [sitegraph module="job" channel="karriere"]
 */
add_shortcode('sitegraph', function ($atts) {
    $a = shortcode_atts(['module' => '', 'channel' => ''], $atts, 'sitegraph');
    if ($a['module'] === '' || $a['channel'] === '') {
        return '<!-- sitegraph: module und channel erforderlich -->';
    }
    wp_enqueue_style('sitegraph');
    return sitegraph_render_content($a['channel'], $a['module']);
});

/** Server-rendered Gutenberg block (SEO-friendly). */
add_action('init', function () {
    if (function_exists('register_block_type')) {
        register_block_type(SITEGRAPH_DIR . 'blocks/content', [
            'render_callback' => 'sitegraph_render_block',
        ]);
    }
});

/** Editor assets for the block (no build step; uses the global wp.* packages). */
add_action('enqueue_block_editor_assets', function () {
    wp_enqueue_script(
        'sitegraph-block',
        SITEGRAPH_URL . 'blocks/content/editor.js',
        ['wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render'],
        SITEGRAPH_VERSION,
        true
    );
});

/**
 * render_callback for the block.
 *
 * @param array $attributes Block attributes (module, channel).
 * @return string
 */
function sitegraph_render_block($attributes) {
    $module  = isset($attributes['module']) ? $attributes['module'] : '';
    $channel = isset($attributes['channel']) ? $attributes['channel'] : '';
    if ($module === '' || $channel === '') {
        return '<div class="sitegraph-empty">SiteGraph: Bitte Modul und Channel im Block wählen.</div>';
    }
    wp_enqueue_style('sitegraph');
    return sitegraph_render_content($channel, $module);
}
