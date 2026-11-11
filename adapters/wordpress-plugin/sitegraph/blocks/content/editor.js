/**
 * SiteGraph block editor script (no build step).
 *
 * Uses the global wp.* packages (enqueued as dependencies in sitegraph.php) and
 * wp.element.createElement instead of JSX, so no compilation is needed — the
 * same philosophy as the no-build web component. The block is dynamic: the
 * preview and the frontend both render server-side via the PHP render_callback.
 */
(function (blocks, element, blockEditor, components, serverSideRender) {
  var el = element.createElement;
  var Fragment = element.Fragment;
  var InspectorControls = blockEditor.InspectorControls;
  var PanelBody = components.PanelBody;
  var TextControl = components.TextControl;
  var ServerSideRender = serverSideRender; // the global IS the component

  blocks.registerBlockType("sitegraph/content", {
    edit: function (props) {
      var a = props.attributes;
      return el(
        Fragment,
        {},
        el(
          InspectorControls,
          {},
          el(
            PanelBody,
            { title: "SiteGraph", initialOpen: true },
            el(TextControl, {
              label: "Modul",
              help: "z. B. job, standort, team",
              value: a.module || "",
              onChange: function (v) {
                props.setAttributes({ module: v });
              },
            }),
            el(TextControl, {
              label: "Channel",
              help: "z. B. karriere, hauptseite",
              value: a.channel || "",
              onChange: function (v) {
                props.setAttributes({ channel: v });
              },
            })
          )
        ),
        a.module && a.channel
          ? el(ServerSideRender, {
              block: "sitegraph/content",
              attributes: a,
            })
          : el(
              "div",
              { style: { padding: "1rem", border: "1px dashed #c3c4c7", borderRadius: "8px" } },
              "SiteGraph: Modul und Channel in den Block-Einstellungen wählen."
            )
      );
    },
    // Dynamic block — rendered by PHP.
    save: function () {
      return null;
    },
  });
})(
  window.wp.blocks,
  window.wp.element,
  window.wp.blockEditor,
  window.wp.components,
  window.wp.serverSideRender
);
