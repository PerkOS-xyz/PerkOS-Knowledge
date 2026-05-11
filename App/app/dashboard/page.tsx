import DashboardClient from '../../components/DashboardClient';
import WalletGate from '../../components/WalletGate';

export default function UserDashboard() {
  return (
    <WalletGate>
      <DashboardClient />
    </WalletGate>
  );
}
