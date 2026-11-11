import { Link } from "react-router-dom";
import { AssistantConversation } from "../components/WorkspaceAssistant";
import { UiIcon } from "../components/ProductIdentity";
import "../agent-workspace.css";

export function AssistantPage() {
  return (
    <div className="nf-agent-page">
      <h1>KI-Assistent</h1>
      <div className="nf-agent-toolbar">
        <p>Dein Gespräch begleitet dich durch den Arbeitsbereich.</p>
        <Link to="/ai/connectors">
          <UiIcon name="settings" />
          Agenten &amp; KI
        </Link>
      </div>
      <div className="ff-assistant-full" id="assistant-full">
        <AssistantConversation section="Inhalte gemeinsam durchdenken" />
      </div>
    </div>
  );
}
