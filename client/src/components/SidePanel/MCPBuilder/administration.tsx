import { createContext, useContext } from 'react';

export const MCPAdministrationContext = createContext(false);

export const useMCPAdministration = () => useContext(MCPAdministrationContext);
