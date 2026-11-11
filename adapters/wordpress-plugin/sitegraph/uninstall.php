<?php
/**
 * Cleanup on uninstall: remove settings and any stale content backups.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('sitegraph_settings');

// Remove persistent stale-content backups (options keyed sitegraph_*_stale).
global $wpdb;
$wpdb->query(
    "DELETE FROM {$wpdb->options} WHERE option_name LIKE 'sitegraph\\_%\\_stale'"
);
