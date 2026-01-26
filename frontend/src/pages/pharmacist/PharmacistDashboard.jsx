import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { supabase } from '../../lib/supabase';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { toast } from 'sonner';
import { 
  Bell, 
  Settings, 
  LogOut,
  Pill,
  Users,
  Menu,
  X,
  Phone,
  MapPin,
  Building2,
  UserPlus,
  Clock,
  CheckCircle2,
  Send,
  ArrowRight,
  Package,
  Shield
} from 'lucide-react';

export default function PharmacistDashboard() {
  const { user, profile, signOut, isPharmacist } = useAuth();
  const { language } = useLanguage();
  const { unreadCount } = useNotifications();
  const navigate = useNavigate();

  // State
  const [pharmacy, setPharmacy] = useState(null);
  const [isOnDuty, setIsOnDuty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  // Connections state
  const [connections, setConnections] = useState({ incoming: 0, outgoing: 0, accepted: 0, recentAccepted: [] });
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [sendingInvite, setSendingInvite] = useState(false);
  
  // Stock requests state
  const [stockRequests, setStockRequests] = useState({ pending: 0, recent: [] });

  // Redirect if not pharmacist
  useEffect(() => {
    if (profile && !isPharmacist()) {
      navigate('/patient');
    }
  }, [profile, isPharmacist, navigate]);

  // Fetch pharmacist's pharmacy
  // TODO: Handle multiple pharmacies - currently using first one
  const fetchPharmacy = useCallback(async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase
        .from('pharmacies')
        .select('*')
        .eq('owner_id', user.id)
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      
      if (data) {
        setPharmacy(data);
        setIsOnDuty(data.is_on_call || false);
      }
      return data;
    } catch (error) {
      console.error('Error fetching pharmacy:', error);
      return null;
    }
  }, [user]);

  // Fetch connections summary
  const fetchConnections = useCallback(async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase
        .from('pharmacist_connections')
        .select(`
          *,
          requester:profiles!pharmacist_connections_requester_pharmacist_id_fkey (
            id, full_name, pharmacy_name
          ),
          target:profiles!pharmacist_connections_target_pharmacist_id_fkey (
            id, full_name, pharmacy_name
          )
        `)
        .or(`requester_pharmacist_id.eq.${user.id},target_pharmacist_id.eq.${user.id}`);

      if (error) throw error;

      const all = data || [];
      const incoming = all.filter(c => c.status === 'pending' && c.target_pharmacist_id === user.id).length;
      const outgoing = all.filter(c => c.status === 'pending' && c.requester_pharmacist_id === user.id).length;
      const acceptedList = all.filter(c => c.status === 'accepted');
      
      setConnections({
        incoming,
        outgoing,
        accepted: acceptedList.length,
        recentAccepted: acceptedList.slice(0, 3)
      });
    } catch (error) {
      console.error('Error fetching connections:', error);
    }
  }, [user]);

  // Fetch stock requests
  const fetchStockRequests = useCallback(async () => {
    if (!pharmacy) return;
    try {
      const { data, error } = await supabase
        .from('stock_requests')
        .select('*')
        .eq('target_pharmacy_id', pharmacy.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error && error.code !== 'PGRST116') throw error;

      setStockRequests({
        pending: data?.length || 0,
        recent: data || []
      });
    } catch (error) {
      console.error('Error fetching stock requests:', error);
    }
  }, [pharmacy]);

  // Toggle on-duty status
  const toggleOnDuty = async (checked) => {
    // Optimistic update
    setIsOnDuty(checked);
    
    try {
      if (!pharmacy) {
        toast.error(language === 'el' ? 'Δεν βρέθηκε φαρμακείο' : 'Pharmacy not found');
        setIsOnDuty(!checked);
        return;
      }

      const { error } = await supabase
        .from('pharmacies')
        .update({ is_on_call: checked })
        .eq('id', pharmacy.id);

      if (error) throw error;

      toast.success(
        checked 
          ? (language === 'el' ? 'Είστε σε εφημερία' : 'You are now on duty')
          : (language === 'el' ? 'Τέλος εφημερίας' : 'You are now off duty')
      );
    } catch (error) {
      // Revert on error
      setIsOnDuty(!checked);
      toast.error(language === 'el' ? 'Σφάλμα ενημέρωσης' : 'Update failed');
    }
  };

  // Send invite
  const sendInvite = async () => {
    if (!inviteEmail.trim()) {
      toast.error(language === 'el' ? 'Εισάγετε email' : 'Enter an email');
      return;
    }

    setSendingInvite(true);
    try {
      // Find pharmacist by email
      const { data: targetProfile, error: findError } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, pharmacy_name')
        .eq('email', inviteEmail.trim().toLowerCase())
        .eq('role', 'pharmacist')
        .single();

      if (findError || !targetProfile) {
        toast.error(language === 'el' ? 'Δεν βρέθηκε φαρμακοποιός' : 'Pharmacist not found');
        return;
      }

      if (targetProfile.id === user.id) {
        toast.error(language === 'el' ? 'Δεν μπορείτε να προσκαλέσετε τον εαυτό σας' : 'Cannot invite yourself');
        return;
      }

      // Check for existing connection
      const { data: existing } = await supabase
        .from('pharmacist_connections')
        .select('id, status')
        .or(
          `and(requester_pharmacist_id.eq.${user.id},target_pharmacist_id.eq.${targetProfile.id}),` +
          `and(requester_pharmacist_id.eq.${targetProfile.id},target_pharmacist_id.eq.${user.id})`
        )
        .maybeSingle();

      if (existing) {
        toast.error(language === 'el' ? 'Υπάρχει ήδη σύνδεση' : 'Connection already exists');
        return;
      }

      // Create invite
      const { error: insertError } = await supabase
        .from('pharmacist_connections')
        .insert({
          requester_pharmacist_id: user.id,
          target_pharmacist_id: targetProfile.id,
          status: 'pending'
        });

      if (insertError) throw insertError;

      toast.success(language === 'el' ? 'Πρόσκληση εστάλη!' : 'Invite sent!');
      setInviteDialogOpen(false);
      setInviteEmail('');
      fetchConnections();
    } catch (error) {
      console.error('Error sending invite:', error);
      toast.error(language === 'el' ? 'Σφάλμα αποστολής' : 'Error sending invite');
    } finally {
      setSendingInvite(false);
    }
  };

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  // Initial data load
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await fetchPharmacy();
      await fetchConnections();
      setLoading(false);
    };
    
    if (user) {
      loadData();
    }
  }, [user, fetchPharmacy, fetchConnections]);

  // Fetch stock requests after pharmacy is loaded
  useEffect(() => {
    if (pharmacy) {
      fetchStockRequests();
    }
  }, [pharmacy, fetchStockRequests]);

  // Realtime subscriptions
  useEffect(() => {
    if (!user) return;

    const connectionsChannel = supabase
      .channel('pharmacist_connections_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pharmacist_connections' }, fetchConnections)
      .subscribe();

    return () => {
      supabase.removeChannel(connectionsChannel);
    };
  }, [user, fetchConnections]);

  if (!isPharmacist()) {
    return null;
  }

  return (
    <div className="min-h-screen bg-pharma-ice-blue" data-testid="pharmacist-dashboard">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-pharma-grey-pale">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-pharma-teal flex items-center justify-center">
              <Pill className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-heading font-bold text-pharma-dark-slate">
                {language === 'el' ? 'Πίνακας Ελέγχου' : 'Dashboard'}
              </h1>
              <p className="text-xs text-pharma-slate-grey">
                {profile?.full_name || user?.email}
              </p>
            </div>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-2">
            <Link to="/pharmacist/connections">
              <Button variant="ghost" className="rounded-full gap-2" data-testid="nav-connections-btn">
                <Users className="w-4 h-4" />
                {language === 'el' ? 'Συνδέσεις' : 'Connections'}
                {connections.incoming > 0 && (
                  <span className="bg-pharma-coral text-white text-xs px-1.5 py-0.5 rounded-full">
                    {connections.incoming}
                  </span>
                )}
              </Button>
            </Link>
            <Link to="/pharmacist/notifications">
              <Button variant="ghost" size="icon" className="rounded-full relative" data-testid="nav-notifications-btn">
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-pharma-coral text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </Button>
            </Link>
            <Link to="/pharmacist/settings">
              <Button variant="ghost" size="icon" className="rounded-full" data-testid="nav-settings-btn">
                <Settings className="w-5 h-5" />
              </Button>
            </Link>
            <Button 
              variant="ghost" 
              size="icon" 
              className="rounded-full text-pharma-slate-grey"
              onClick={handleSignOut}
              data-testid="signout-btn"
            >
              <LogOut className="w-5 h-5" />
            </Button>
          </nav>

          {/* Mobile Menu Toggle */}
          <Button 
            variant="ghost" 
            size="icon" 
            className="md:hidden rounded-full"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            data-testid="mobile-menu-btn"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white border-t border-pharma-grey-pale p-4 space-y-2 animate-slide-up">
            <Link to="/pharmacist/connections" onClick={() => setMobileMenuOpen(false)}>
              <Button variant="ghost" className="w-full justify-start gap-3 rounded-xl">
                <Users className="w-5 h-5" />
                {language === 'el' ? 'Συνδέσεις' : 'Connections'}
                {connections.incoming > 0 && (
                  <span className="bg-pharma-coral text-white text-xs px-1.5 py-0.5 rounded-full ml-auto">
                    {connections.incoming}
                  </span>
                )}
              </Button>
            </Link>
            <Link to="/pharmacist/notifications" onClick={() => setMobileMenuOpen(false)}>
              <Button variant="ghost" className="w-full justify-start gap-3 rounded-xl">
                <Bell className="w-5 h-5" />
                {language === 'el' ? 'Ειδοποιήσεις' : 'Notifications'}
              </Button>
            </Link>
            <Link to="/pharmacist/settings" onClick={() => setMobileMenuOpen(false)}>
              <Button variant="ghost" className="w-full justify-start gap-3 rounded-xl">
                <Settings className="w-5 h-5" />
                {language === 'el' ? 'Ρυθμίσεις' : 'Settings'}
              </Button>
            </Link>
            <Button 
              variant="ghost" 
              className="w-full justify-start gap-3 rounded-xl text-pharma-slate-grey"
              onClick={handleSignOut}
            >
              <LogOut className="w-5 h-5" />
              {language === 'el' ? 'Αποσύνδεση' : 'Sign Out'}
            </Button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {loading ? (
          <div className="grid md:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map(i => (
              <Card key={i} className="bg-white rounded-2xl shadow-card border-pharma-grey-pale animate-pulse">
                <CardContent className="p-6 h-40" />
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            {/* STATUS CARD - On Duty Toggle */}
            <Card className="bg-white rounded-2xl shadow-card border-pharma-grey-pale page-enter" data-testid="status-card">
              <CardHeader className="pb-2">
                <CardTitle className="font-heading text-lg text-pharma-dark-slate flex items-center gap-2">
                  <Clock className="w-5 h-5 text-pharma-teal" />
                  {language === 'el' ? 'Κατάσταση Εφημερίας' : 'Duty Status'}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-pharma-charcoal font-medium">
                      {isOnDuty 
                        ? (language === 'el' ? 'Σε Εφημερία' : 'On Duty')
                        : (language === 'el' ? 'Εκτός Εφημερίας' : 'Off Duty')
                      }
                    </p>
                    <p className="text-sm text-pharma-slate-grey">
                      {isOnDuty
                        ? (language === 'el' ? 'Οι ασθενείς μπορούν να σας βρουν' : 'Patients can find you')
                        : (language === 'el' ? 'Δεν εμφανίζεστε στις αναζητήσεις' : 'Not visible in searches')
                      }
                    </p>
                  </div>
                  <Switch
                    checked={isOnDuty}
                    onCheckedChange={toggleOnDuty}
                    className="data-[state=checked]:bg-pharma-sea-green"
                    data-testid="on-duty-toggle"
                  />
                </div>
              </CardContent>
            </Card>

            {/* PHARMACY PROFILE CARD */}
            <Card className="bg-white rounded-2xl shadow-card border-pharma-grey-pale page-enter" style={{ animationDelay: '0.05s' }} data-testid="pharmacy-card">
              <CardHeader className="pb-2">
                <CardTitle className="font-heading text-lg text-pharma-dark-slate flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-pharma-royal-blue" />
                  {language === 'el' ? 'Το Φαρμακείο Μου' : 'My Pharmacy'}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                {pharmacy ? (
                  <div className="space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium text-pharma-dark-slate">{pharmacy.name}</p>
                        {pharmacy.is_verified && (
                          <span className="inline-flex items-center gap-1 text-xs text-pharma-sea-green mt-1">
                            <Shield className="w-3 h-3" />
                            {language === 'el' ? 'Επαληθευμένο' : 'Verified'}
                          </span>
                        )}
                      </div>
                    </div>
                    {pharmacy.address && (
                      <p className="text-sm text-pharma-slate-grey flex items-center gap-2">
                        <MapPin className="w-4 h-4 flex-shrink-0" />
                        {pharmacy.address}
                      </p>
                    )}
                    {pharmacy.phone && (
                      <p className="text-sm text-pharma-slate-grey flex items-center gap-2">
                        <Phone className="w-4 h-4 flex-shrink-0" />
                        {pharmacy.phone}
                      </p>
                    )}
                    <Link to="/pharmacist/settings">
                      <Button variant="outline" size="sm" className="rounded-full mt-2" data-testid="edit-pharmacy-btn">
                        {language === 'el' ? 'Επεξεργασία' : 'Edit Profile'}
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <p className="text-pharma-slate-grey mb-3">
                      {language === 'el' ? 'Δεν έχετε φαρμακείο' : 'No pharmacy registered'}
                    </p>
                    <Link to="/pharmacist/settings">
                      <Button className="rounded-full bg-pharma-teal hover:bg-pharma-teal/90" data-testid="add-pharmacy-btn">
                        {language === 'el' ? 'Προσθήκη Φαρμακείου' : 'Add Pharmacy'}
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* CONNECTIONS SUMMARY CARD */}
            <Card className="bg-white rounded-2xl shadow-card border-pharma-grey-pale page-enter" style={{ animationDelay: '0.1s' }} data-testid="connections-card">
              <CardHeader className="pb-2">
                <CardTitle className="font-heading text-lg text-pharma-dark-slate flex items-center gap-2">
                  <Users className="w-5 h-5 text-pharma-steel-blue" />
                  {language === 'el' ? 'Συνδέσεις Φαρμακοποιών' : 'Pharmacist Connections'}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="text-center p-3 bg-pharma-ice-blue rounded-xl">
                    <p className="text-2xl font-bold text-pharma-coral" data-testid="incoming-count">
                      {connections.incoming}
                    </p>
                    <p className="text-xs text-pharma-slate-grey">
                      {language === 'el' ? 'Εισερχόμενες' : 'Incoming'}
                    </p>
                  </div>
                  <div className="text-center p-3 bg-pharma-ice-blue rounded-xl">
                    <p className="text-2xl font-bold text-pharma-royal-blue" data-testid="outgoing-count">
                      {connections.outgoing}
                    </p>
                    <p className="text-xs text-pharma-slate-grey">
                      {language === 'el' ? 'Απεσταλμένες' : 'Outgoing'}
                    </p>
                  </div>
                  <div className="text-center p-3 bg-pharma-ice-blue rounded-xl">
                    <p className="text-2xl font-bold text-pharma-sea-green" data-testid="accepted-count">
                      {connections.accepted}
                    </p>
                    <p className="text-xs text-pharma-slate-grey">
                      {language === 'el' ? 'Ενεργές' : 'Active'}
                    </p>
                  </div>
                </div>

                {/* Recent Accepted Connections */}
                {connections.recentAccepted.length > 0 && (
                  <div className="space-y-2 mb-4">
                    <p className="text-xs font-medium text-pharma-slate-grey uppercase">
                      {language === 'el' ? 'Πρόσφατες' : 'Recent'}
                    </p>
                    {connections.recentAccepted.map((conn) => {
                      const otherUser = conn.requester_pharmacist_id === user?.id ? conn.target : conn.requester;
                      return (
                        <div key={conn.id} className="flex items-center gap-2 p-2 bg-pharma-grey-pale/30 rounded-lg">
                          <CheckCircle2 className="w-4 h-4 text-pharma-sea-green flex-shrink-0" />
                          <span className="text-sm text-pharma-charcoal truncate">
                            {otherUser?.full_name || otherUser?.pharmacy_name || 'Unknown'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-2">
                  <Button
                    className="flex-1 rounded-full bg-pharma-teal hover:bg-pharma-teal/90 gap-2"
                    onClick={() => setInviteDialogOpen(true)}
                    data-testid="invite-pharmacist-btn"
                  >
                    <UserPlus className="w-4 h-4" />
                    {language === 'el' ? 'Πρόσκληση' : 'Invite'}
                  </Button>
                  <Link to="/pharmacist/connections" className="flex-1">
                    <Button variant="outline" className="w-full rounded-full gap-2" data-testid="view-connections-btn">
                      {language === 'el' ? 'Όλες' : 'View All'}
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>

            {/* STOCK REQUESTS SUMMARY */}
            <Card className="bg-white rounded-2xl shadow-card border-pharma-grey-pale page-enter" style={{ animationDelay: '0.15s' }} data-testid="stock-requests-card">
              <CardHeader className="pb-2">
                <CardTitle className="font-heading text-lg text-pharma-dark-slate flex items-center gap-2">
                  <Package className="w-5 h-5 text-pharma-coral" />
                  {language === 'el' ? 'Αιτήματα Αποθέματος' : 'Stock Requests'}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="flex items-center justify-between mb-4 p-3 bg-pharma-coral/10 rounded-xl">
                  <div>
                    <p className="text-2xl font-bold text-pharma-coral" data-testid="pending-requests-count">
                      {stockRequests.pending}
                    </p>
                    <p className="text-sm text-pharma-slate-grey">
                      {language === 'el' ? 'Εκκρεμή αιτήματα' : 'Pending requests'}
                    </p>
                  </div>
                  <Package className="w-10 h-10 text-pharma-coral/30" />
                </div>

                {stockRequests.recent.length > 0 ? (
                  <div className="space-y-2 mb-4">
                    {stockRequests.recent.slice(0, 3).map((req) => (
                      <div key={req.id} className="flex items-center gap-2 p-2 bg-pharma-grey-pale/30 rounded-lg">
                        <Clock className="w-4 h-4 text-pharma-coral flex-shrink-0" />
                        <span className="text-sm text-pharma-charcoal truncate">
                          {req.medicine_name || 'Stock request'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-pharma-slate-grey text-center py-4">
                    {language === 'el' ? 'Δεν υπάρχουν εκκρεμή αιτήματα' : 'No pending requests'}
                  </p>
                )}

                <Link to="/pharmacist/inter-pharmacy">
                  <Button variant="outline" className="w-full rounded-full gap-2" data-testid="view-requests-btn">
                    {language === 'el' ? 'Διαχείριση Αιτημάτων' : 'Manage Requests'}
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      {/* Invite Dialog */}
      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent className="bg-white rounded-2xl">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl text-pharma-dark-slate">
              {language === 'el' ? 'Πρόσκληση Φαρμακοποιού' : 'Invite Pharmacist'}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <p className="text-sm text-pharma-slate-grey">
              {language === 'el' 
                ? 'Εισάγετε το email του φαρμακοποιού.'
                : 'Enter the pharmacist\'s email address.'}
            </p>
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="pharmacist@example.com"
              className="rounded-xl"
              data-testid="invite-email-input"
            />
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => {
                setInviteDialogOpen(false);
                setInviteEmail('');
              }}
            >
              {language === 'el' ? 'Ακύρωση' : 'Cancel'}
            </Button>
            <Button
              className="rounded-full bg-pharma-teal hover:bg-pharma-teal/90 gap-2"
              onClick={sendInvite}
              disabled={sendingInvite}
              data-testid="send-invite-btn"
            >
              <Send className="w-4 h-4" />
              {sendingInvite 
                ? (language === 'el' ? 'Αποστολή...' : 'Sending...')
                : (language === 'el' ? 'Αποστολή' : 'Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
