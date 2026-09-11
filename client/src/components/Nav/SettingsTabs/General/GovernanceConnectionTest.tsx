import { Button, Spinner, useToastContext } from '@librechat/client';
import { useTestGovernanceConnectionMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function GovernanceConnectionTest() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const testConnection = useTestGovernanceConnectionMutation();

  const handleTest = () => {
    testConnection.mutate(undefined, {
      onSuccess: () => {
        showToast({
          message: localize('com_ui_governance_connection_success'),
          status: 'success',
        });
      },
      onError: () => {
        showToast({
          message: localize('com_ui_governance_connection_error'),
          status: 'error',
        });
      },
    });
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div id="governance-connection-label">{localize('com_ui_governance_connection_label')}</div>
        <div className="mt-1 text-xs text-text-secondary">
          {localize('com_ui_governance_connection_description')}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        aria-labelledby="governance-connection-label"
        disabled={testConnection.isLoading}
        onClick={handleTest}
      >
        {testConnection.isLoading ? <Spinner className="h-4 w-4" /> : localize('com_ui_test')}
      </Button>
    </div>
  );
}
