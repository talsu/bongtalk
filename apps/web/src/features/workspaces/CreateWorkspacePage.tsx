import { useNavigate } from 'react-router-dom';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';

/**
 * Back-compat wrapper for the legacy `/w/new` URL. The shell rail "+"
 * button is now the canonical entry point and opens the same DS Dialog
 * in place. This route exists so external bookmarks still lead
 * somewhere sensible: render the dialog on top of a blank backdrop;
 * closing (cancel / submit / Esc) sends the user back to /dm.
 */
export function CreateWorkspacePage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div
      data-testid="create-workspace-page"
      className="h-full w-full"
      style={{ background: 'var(--bg-app)' }}
    >
      <CreateWorkspaceDialog
        open
        onOpenChange={(next) => {
          if (!next) navigate('/dm');
        }}
      />
    </div>
  );
}
