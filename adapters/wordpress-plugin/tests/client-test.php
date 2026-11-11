<?php
// Standalone WordPress stubs: synthetic data only, no network or database.
define('ABSPATH', __DIR__);
class WP_Error {}
$options = [];
$transients = [];
$http = [];
$requests = [];
function get_option($key, $fallback = false) { global $options; return array_key_exists($key, $options) ? $options[$key] : $fallback; }
function update_option($key, $value, $autoload = false) { global $options; $options[$key] = $value; return true; }
function delete_option($key) { global $options; unset($options[$key]); return true; }
function get_transient($key) { global $transients; return isset($transients[$key]) ? $transients[$key] : false; }
function set_transient($key, $value, $ttl) { global $transients; $transients[$key] = $value; check($ttl === 60, 'fresh TTL'); return true; }
function delete_transient($key) { global $transients; unset($transients[$key]); return true; }
function is_wp_error($value) { return $value instanceof WP_Error; }
function wp_remote_get($url, $args) { global $http, $requests; $requests[] = [$url, $args]; check(count($http) > 0, 'unexpected request'); return array_shift($http); }
function wp_remote_retrieve_response_code($response) { return $response['status']; }
function wp_remote_retrieve_body($response) { return $response['body']; }
function esc_attr($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
function esc_html($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
require __DIR__ . '/../sitegraph/includes/class-sitegraph-client.php';
require __DIR__ . '/../sitegraph/includes/render.php';

function check($condition, $message) { if (!$condition) throw new RuntimeException($message); }
function reset_fixture() {
    global $options, $transients, $http, $requests;
    $options = ['sitegraph_settings' => ['api_url' => 'https://delivery.fixture.test/', 'token' => 'private-fixture-token-a']];
    $transients = []; $requests = []; $http = [];
}
function queue_live($name = 'First') { global $http; $http[] = ['status' => 200, 'body' => json_encode(['items' => [['name' => $name]]])]; }
function queue_status($status) { global $http; $http[] = ['status' => $status, 'body' => '{}']; }
function fetch_fixture($channel = 'public', $module = 'standort') { return SiteGraph_Client::fetch($channel, $module); }
function backup_keys() { global $options; return array_values(array_filter(array_keys($options), function ($key) { return substr($key, -6) === '_stale'; })); }
function expire_fresh() { global $transients; $transients = []; }
function age_backups($age) { global $options; foreach (backup_keys() as $key) $options[$key]['saved_at'] = time() - $age; }
function unavailable($body) { check(isset($body['error']) && $body['items'] === [] && empty($body['_stale']), 'expected unavailable without stale items'); }

$tests = [
    'fresh content is scoped to API, channel, type and hashed token' => function () {
        global $options, $transients, $requests;
        reset_fixture(); queue_live();
        $first = fetch_fixture();
        check($first['items'][0]['name'] === 'First', 'live content');
        check(fetch_fixture() === $first && count($requests) === 1, 'fresh cache hit');
        foreach (array_keys($transients) as $key) {
            check(preg_match('/^sitegraph_v2_[a-f0-9]{64}$/', $key) === 1, 'versioned hash key');
            check(strpos($key, 'private-fixture-token-a') === false, 'no raw token in key');
        }
        check(strpos(json_encode(array_values($transients)), 'private-fixture-token-a') === false, 'no raw token in cache value');
        $options['sitegraph_settings']['token'] = 'private-fixture-token-b'; queue_status(503); unavailable(fetch_fixture());
        $options['sitegraph_settings']['token'] = 'private-fixture-token-a';
        $options['sitegraph_settings']['api_url'] = 'https://other.fixture.test'; queue_status(503); unavailable(fetch_fixture());
        $options['sitegraph_settings']['api_url'] = 'https://delivery.fixture.test/';
        queue_status(503); unavailable(fetch_fixture('other'));
        queue_status(503); unavailable(fetch_fixture('public', 'job'));
        check($requests[0][1]['redirection'] === 0, 'do not redirect bearer token');
    },
    'network and 5xx fallback is visible and expires from the original fetch time' => function () {
        global $http, $options;
        reset_fixture(); queue_live(); fetch_fixture(); expire_fresh(); age_backups(840);
        $http[] = new WP_Error();
        $fallback = fetch_fixture();
        check(!empty($fallback['_stale']) && $fallback['items'][0]['name'] === 'First', 'network stale');
        queue_status(503);
        $html = sitegraph_render_content('public', 'standort');
        check(strpos($html, 'sitegraph-stale-note') !== false && strpos($html, 'First') !== false, 'visible fallback notice');
        age_backups(900); queue_status(503); unavailable(fetch_fixture());
        check(count(backup_keys()) === 0, 'expired backup deleted');
    },
    'authorization and not-found errors discard snapshots for later outages too' => function () {
        foreach ([301, 400, 401, 403, 404, 408, 429] as $status) {
            reset_fixture(); queue_live(); fetch_fixture(); expire_fresh();
            queue_status($status); unavailable(fetch_fixture());
            check(count(backup_keys()) === 0, 'HTTP ' . $status . ' backup discarded');
            queue_status(503); unavailable(fetch_fixture());
        }
    },
    'malformed JSON and bodies cannot fall back, empty content replaces prior publication' => function () {
        global $http;
        foreach (['{broken', '{}', '{"items":null}', '{"items":[null]}', '{"items":{"unexpected":{"name":"Wrong"}}}'] as $body) {
            reset_fixture(); queue_live(); fetch_fixture(); expire_fresh();
            $http[] = ['status' => 200, 'body' => $body]; unavailable(fetch_fixture());
            check(count(backup_keys()) === 0, 'invalid body backup discarded');
        }
        reset_fixture(); queue_live(); fetch_fixture(); expire_fresh();
        $http[] = ['status' => 200, 'body' => '{"items":[]}'];
        check(fetch_fixture()['items'] === [], 'empty delivery accepted');
        expire_fresh(); queue_status(503);
        $fallback = fetch_fixture();
        check($fallback['items'] === [] && !empty($fallback['_stale']), 'empty snapshot remains empty during outage');
    },
    'legacy, future-dated and malformed cache entries are never served' => function () {
        global $options, $transients;
        reset_fixture();
        $legacy = 'sitegraph_' . md5('https://delivery.fixture.test|public|standort');
        $options[$legacy . '_stale'] = ['items' => [['name' => 'Legacy']]];
        $transients[$legacy] = $options[$legacy . '_stale'];
        queue_status(503); unavailable(fetch_fixture());
        foreach ([-30, 901] as $age) {
            reset_fixture(); queue_live(); fetch_fixture(); expire_fresh(); age_backups($age);
            queue_status(503); unavailable(fetch_fixture());
        }
        reset_fixture(); queue_live(); fetch_fixture(); expire_fresh();
        $options[backup_keys()[0]] = ['version' => 2, 'saved_at' => time(), 'body' => ['items' => 'bad']];
        queue_status(503); unavailable(fetch_fixture());
    },
    'expired fresh entries revalidate and server metadata cannot masquerade as stale or error' => function () {
        global $transients, $http;
        reset_fixture(); queue_live(); fetch_fixture();
        foreach ($transients as &$entry) $entry['saved_at'] = time() - 60;
        unset($entry);
        $http[] = ['status' => 200, 'body' => '{"items":[{"name":"Fresh"}],"_stale":true,"error":"unavailable"}'];
        $body = fetch_fixture();
        check($body['items'][0]['name'] === 'Fresh' && !isset($body['_stale']) && !isset($body['error']), 'fresh validated delivery');
    },
    'output stays escaped and unconfigured clients do not send requests' => function () {
        global $options, $requests;
        reset_fixture(); queue_live('<img src=x onerror=alert(1)>');
        $html = sitegraph_render_content('public', 'standort');
        check(strpos($html, '<img') === false && strpos($html, '&lt;img') !== false, 'escaped published content');
        $options['sitegraph_settings']['token'] = '';
        check(fetch_fixture()['error'] === 'not_configured' && count($requests) === 1, 'no unconfigured request');
    },
];
foreach ($tests as $name => $run) {
    $run();
    echo 'PASS ' . $name . PHP_EOL;
}
echo count($tests) . ' tests passed.' . PHP_EOL;
