<?php
/**
 * Settings page: API base URL + delivery token (WP1.9).
 * Standard WordPress Settings API, capability-gated to administrators.
 */

if (!defined('ABSPATH')) {
    exit;
}

class SiteGraph_Settings {

    const OPTION = 'sitegraph_settings';
    const GROUP  = 'sitegraph';

    public static function init() {
        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_init', [__CLASS__, 'register']);
    }

    public static function menu() {
        add_options_page('SiteGraph', 'SiteGraph', 'manage_options', 'sitegraph', [__CLASS__, 'page']);
    }

    public static function register() {
        register_setting(self::GROUP, self::OPTION, [
            'type'              => 'array',
            'sanitize_callback' => [__CLASS__, 'sanitize'],
            'default'           => ['api_url' => '', 'token' => ''],
        ]);
    }

    public static function sanitize($input) {
        return [
            'api_url' => isset($input['api_url']) ? esc_url_raw(trim((string) $input['api_url'])) : '',
            'token'   => isset($input['token']) ? sanitize_text_field(trim((string) $input['token'])) : '',
        ];
    }

    public static function page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        $o = get_option(self::OPTION, ['api_url' => '', 'token' => '']);
        ?>
        <div class="wrap">
            <h1>SiteGraph</h1>
            <form method="post" action="options.php">
                <?php settings_fields(self::GROUP); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="sg-url">API-URL</label></th>
                        <td>
                            <input type="url" id="sg-url" class="regular-text"
                                name="<?php echo esc_attr(self::OPTION); ?>[api_url]"
                                value="<?php echo esc_attr($o['api_url']); ?>"
                                placeholder="https://api.deine-sitegraph-instanz.de">
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="sg-token">Delivery-Token</label></th>
                        <td>
                            <input type="text" id="sg-token" class="regular-text"
                                name="<?php echo esc_attr(self::OPTION); ?>[token]"
                                value="<?php echo esc_attr($o['token']); ?>"
                                placeholder="sg_…">
                            <p class="description">Org-weiter oder channel-gebundener Token aus der SiteGraph-Admin-Oberfläche.</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button(); ?>
            </form>
            <h2>Nutzung</h2>
            <p>Shortcode: <code>[sitegraph module="job" channel="karriere"]</code></p>
            <p>Oder den Block <strong>„SiteGraph Inhalt"</strong> einfügen und Modul + Channel wählen.</p>
        </div>
        <?php
    }
}
