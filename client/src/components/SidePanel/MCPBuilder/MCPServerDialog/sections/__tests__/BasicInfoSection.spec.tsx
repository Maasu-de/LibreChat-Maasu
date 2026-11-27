import React from 'react';
import { render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { MCPServerFormData } from '../../hooks/useMCPServerForm';
import { MCPAdministrationContext } from '../../../administration';
import BasicInfoSection from '../BasicInfoSection';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

function BasicInfo({ administration }: { administration: boolean }) {
  const form = useForm<MCPServerFormData>();
  return (
    <MCPAdministrationContext.Provider value={administration}>
      <FormProvider {...form}>
        <BasicInfoSection />
      </FormProvider>
    </MCPAdministrationContext.Provider>
  );
}

it('replaces the icon picker with the default icon in governed administration', () => {
  const { container } = render(<BasicInfo administration />);
  expect(screen.queryByRole('button', { name: 'com_ui_upload_icon' })).not.toBeInTheDocument();
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
});

it('keeps the icon picker in the non-governed form', () => {
  render(<BasicInfo administration={false} />);
  expect(screen.getByRole('button', { name: 'com_ui_upload_icon' })).toBeInTheDocument();
});
