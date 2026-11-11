<?php
/**
 * Server-side Delivery client. Cache entries are scoped to API, channel, type
 * and token hash. Fallback is limited to network / 5xx failures and 15 minutes
 * since the successful fetch. Authorization / not-found errors discard caches.
 */

if (!defined('ABSPATH')) {
    exit;
}

class SiteGraph_Client {
    const FRESH_TTL = 60;
    const MAX_STALE_AGE = 900;

    /** @return array{api_url:string, token:string} */
    public static function settings() {
        $o = get_option('sitegraph_settings', []);
        return [
            'api_url' => isset($o['api_url']) ? rtrim((string) $o['api_url'], '/') : '',
            'token'   => isset($o['token']) ? (string) $o['token'] : '',
        ];
    }

    private static function valid_body($body) {
        if (!is_array($body) || !isset($body['items']) || !is_array($body['items'])) {
            return false;
        }
        // Delivery returns a list of content objects, including an empty list.
        if ($body['items'] !== array_values($body['items'])) {
            return false;
        }
        foreach ($body['items'] as $item) {
            if (!is_array($item)) {
                return false;
            }
        }
        return true;
    }

    private static function valid_entry($entry, $max_age) {
        if (!is_array($entry) || !isset($entry['version'], $entry['saved_at'], $entry['body']) ||
            $entry['version'] !== 2 || !is_int($entry['saved_at'])) {
            return false;
        }
        $age = time() - $entry['saved_at'];
        return $age >= 0 && $age < $max_age && self::valid_body($entry['body']);
    }

    /**
     * @param string $channel Channel slug.
     * @param string $module Content type key.
     * @return array Decoded delivery body (`items`), possibly flagged `_stale`.
     */
    public static function fetch($channel, $module) {
        $s = self::settings();
        if ($s['api_url'] === '' || $s['token'] === '') {
            return ['items' => [], 'error' => 'not_configured'];
        }

        // Encode separate dimensions before hashing; no delimiter ambiguity and
        // no plaintext token in either the key or the persisted response body.
        $scope = json_encode([$s['api_url'], (string) $channel, (string) $module, hash('sha256', $s['token'])]);
        if ($scope === false) {
            return ['items' => [], 'error' => 'invalid_configuration'];
        }
        $base_key = 'sitegraph_v2_' . hash('sha256', $scope);
        $stale_key = $base_key . '_stale';
        $fresh = get_transient($base_key);
        if (self::valid_entry($fresh, self::FRESH_TTL)) {
            return $fresh['body'];
        }
        if ($fresh !== false) {
            delete_transient($base_key);
        }

        $url = $s['api_url'] . '/v1/' . rawurlencode($channel) . '/content/' . rawurlencode($module);
        $res = wp_remote_get($url, [
            'timeout' => 5,
            'redirection' => 0,
            'headers' => ['Authorization' => 'Bearer ' . $s['token']],
        ]);
        $network_error = is_wp_error($res);
        $status = $network_error ? 0 : (int) wp_remote_retrieve_response_code($res);
        if ($status === 200) {
            $body = json_decode(wp_remote_retrieve_body($res), true);
            if (json_last_error() === JSON_ERROR_NONE && self::valid_body($body)) {
                // Adapter metadata is ours, never carried forward from a body.
                unset($body['_stale'], $body['error']);
                $entry = ['version' => 2, 'saved_at' => time(), 'body' => $body];
                set_transient($base_key, $entry, self::FRESH_TTL);
                update_option($stale_key, $entry, false);
                return $body;
            }
        }

        if ($network_error || ($status >= 500 && $status <= 599)) {
            $stale = get_option($stale_key, false);
            if (self::valid_entry($stale, self::MAX_STALE_AGE)) {
                $body = $stale['body'];
                $body['_stale'] = true;
                return $body;
            }
        }

        // No fallback for 401/403/404, other 4xx, redirects or invalid JSON.
        // Expired/malformed backups are discarded as well.
        delete_transient($base_key);
        delete_option($stale_key);
        return ['items' => [], 'error' => 'unavailable'];
    }
}
