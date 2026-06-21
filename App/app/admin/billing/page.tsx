import WalletGate from '../../../components/WalletGate';
import AdminClient from '../../../components/AdminClient';

export const dynamic = 'force-dynamic';

export default function AdminBillingPage() {
  return (
    <WalletGate>
      <AdminClient />
    </WalletGate>
  );
}
