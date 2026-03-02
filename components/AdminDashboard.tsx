
import React, { useState, useEffect, useMemo } from 'react';
import { 
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, 
    LineChart, Line, CartesianGrid, Legend 
} from 'recharts';
import { LogEntry } from '../types';

interface DashboardStats {
    totalGenerations: number;
    scriptCount: number;
    avatarCount: number;
    videoCount: number;
    exportCount: number; // Gamerhead videos produced
    totalUsers: number;
    ratioHorizontal: number;
    ratioVertical: number;
    dailyActivity: { date: string; [key: string]: number | string }[];
    modelUsage: { name: string; count: number }[];
}

const AdminDashboard: React.FC = () => {
    // --- State ---
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    
    // Filters
    const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d' | 'custom'>('7d');
    const [startDate, setStartDate] = useState<string>("");
    const [endDate, setEndDate] = useState<string>("");
    const [selectedUser, setSelectedUser] = useState<string>("all");
    const [sortConfig, setSortConfig] = useState<{ key: keyof LogEntry | 'dateString'; direction: 'asc' | 'desc' }>({ key: 'timestamp', direction: 'desc' });

    // --- Helpers ---
    const getDateRange = (range: '7d' | '30d' | '90d') => {
        const end = new Date();
        const start = new Date();
        if (range === '7d') start.setDate(end.getDate() - 7);
        if (range === '30d') start.setDate(end.getDate() - 30);
        if (range === '90d') start.setDate(end.getDate() - 90);
        return { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] };
    };

    // Initialize Dates
    useEffect(() => {
        if (timeRange !== 'custom') {
            const { start, end } = getDateRange(timeRange);
            setStartDate(start);
            setEndDate(end);
        }
    }, [timeRange]);

    // Fetch Data
    const fetchData = async () => {
        setLoading(true);
        try {
            // End date should include the full day
            const endD = new Date(endDate);
            endD.setHours(23, 59, 59, 999);
            
            const query = new URLSearchParams({
                from: new Date(startDate).toISOString(),
                to: endD.toISOString()
            });

            const res = await fetch(`/api/admin/stats?${query}`);
            if (!res.ok) throw new Error("Failed to fetch logs");
            
            const data = await res.json();
            setLogs(data.logs || []);
            setError(null);
        } catch (err: any) {
            console.error("Dashboard fetch error:", err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // Trigger fetch on date change (debounced slightly or effect driven)
    useEffect(() => {
        if (startDate && endDate) {
            fetchData();
        }
    }, [startDate, endDate]);

    // --- Derived Data (Client-Side Filtering & Aggregation) ---
    
    // 1. User List
    const uniqueUsers = useMemo(() => {
        const users = new Set<string>();
        logs.forEach(l => { if (l.userId) users.add(l.userId); });
        return Array.from(users);
    }, [logs]);

    // 2. Filter Logs by User
    const filteredLogs = useMemo(() => {
        if (selectedUser === 'all') return logs;
        return logs.filter(l => l.userId === selectedUser);
    }, [logs, selectedUser]);

    // 3. Sort Logs for Table
    const sortedLogs = useMemo(() => {
        const sorted = [...filteredLogs].sort((a, b) => {
            if (a[sortConfig.key as keyof LogEntry] < b[sortConfig.key as keyof LogEntry]) {
                return sortConfig.direction === 'asc' ? -1 : 1;
            }
            if (a[sortConfig.key as keyof LogEntry] > b[sortConfig.key as keyof LogEntry]) {
                return sortConfig.direction === 'asc' ? 1 : -1;
            }
            return 0;
        });
        return sorted;
    }, [filteredLogs, sortConfig]);

    // 4. Calculate Stats
    const stats: DashboardStats = useMemo(() => {
        const s = {
            totalGenerations: 0,
            scriptCount: 0,
            avatarCount: 0,
            videoCount: 0,
            exportCount: 0,
            totalUsers: uniqueUsers.length, // Total users in this range
            ratioHorizontal: 0,
            ratioVertical: 0,
            dailyActivity: [] as any[],
            modelUsage: [] as any[]
        };

        const dailyMap: Record<string, any> = {};
        const modelMap: Record<string, number> = {};
        let horizontalExports = 0;
        let verticalExports = 0;

        filteredLogs.forEach(log => {
            // General Counts
            if (log.status === 'success') {
                if (log.type === 'script') s.scriptCount++;
                if (log.type === 'image') s.avatarCount++;
                if (log.type === 'video') s.videoCount++;
                if (log.type === 'export') {
                    s.exportCount++;
                    // Aspect Ratio from Meta
                    if (log.meta?.aspectRatio === '16:9') horizontalExports++;
                    if (log.meta?.aspectRatio === '9:16') verticalExports++;
                }
                
                // Model Usage
                if (log.model) {
                    const mName = log.model.replace('gemini-', '').replace('veo-', '');
                    modelMap[mName] = (modelMap[mName] || 0) + 1;
                }
            }

            // Daily Activity
            const dateKey = new Date(log.timestamp).toISOString().split('T')[0];
            if (!dailyMap[dateKey]) {
                dailyMap[dateKey] = { date: dateKey };
            }
            // Add specific model count to daily entry
            if (log.model) {
                 const mName = log.model.replace('gemini-', '').replace('veo-', '');
                 dailyMap[dateKey][mName] = (dailyMap[dateKey][mName] || 0) + 1;
            }
        });

        s.totalGenerations = s.scriptCount + s.avatarCount + s.videoCount;
        s.ratioHorizontal = horizontalExports;
        s.ratioVertical = verticalExports;
        
        s.dailyActivity = Object.values(dailyMap).sort((a,b) => a.date.localeCompare(b.date));
        s.modelUsage = Object.entries(modelMap).map(([name, count]) => ({ name, count }));

        return s;
    }, [filteredLogs, uniqueUsers]);

    // --- Chart Config ---
    // Extract unique model keys for the line chart lines
    const modelKeys = useMemo(() => {
        const keys = new Set<string>();
        stats.dailyActivity.forEach(day => {
            Object.keys(day).forEach(k => {
                if (k !== 'date') keys.add(k);
            });
        });
        return Array.from(keys);
    }, [stats.dailyActivity]);

    // Color Palette for charts
    const colors = ['#8AB4F8', '#81C995', '#F28B82', '#FDD663', '#C58AF9', '#78D9EC'];

    const handleSort = (key: keyof LogEntry) => {
        setSortConfig(prev => ({
            key,
            direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
        }));
    };

    const handleExportCSV = () => {
        const headers = ["Timestamp", "User ID", "Type", "Model", "Status"];
        const rows = filteredLogs.map(log => [
            new Date(log.timestamp).toISOString(),
            log.userId,
            log.type,
            log.model,
            log.status
        ]);
        const csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + rows.map(e => e.join(",")).join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `admin_logs_${new Date().toISOString()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div className="p-4 md:p-8 max-w-[1600px] mx-auto animate-fade-in pb-20">
            
            {/* --- Filter Bar --- */}
            <div className="bg-google-surface border border-gray-700 rounded-2xl p-6 mb-8 shadow-card sticky top-4 z-30 backdrop-blur-md bg-opacity-95">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-6">
                    
                    {/* Time Range */}
                    <div className="flex flex-col md:flex-row gap-4 items-center w-full xl:w-auto">
                        <div className="flex bg-gray-800 p-1 rounded-lg border border-gray-700">
                            {(['7d', '30d', '90d'] as const).map(r => (
                                <button
                                    key={r}
                                    onClick={() => setTimeRange(r)}
                                    className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${
                                        timeRange === r ? 'bg-gray-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
                                    }`}
                                >
                                    Last {r.replace('d', ' Days')}
                                </button>
                            ))}
                            <button
                                onClick={() => setTimeRange('custom')}
                                className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${
                                    timeRange === 'custom' ? 'bg-gray-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
                                }`}
                            >
                                Custom
                            </button>
                        </div>
                        
                        <div className="flex items-center gap-2">
                             <input 
                                type="date" 
                                value={startDate} 
                                onChange={(e) => { setStartDate(e.target.value); setTimeRange('custom'); }}
                                className="bg-[#2D2D2D] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-google-blue outline-none"
                             />
                             <span className="text-gray-500 font-bold">to</span>
                             <input 
                                type="date" 
                                value={endDate} 
                                onChange={(e) => { setEndDate(e.target.value); setTimeRange('custom'); }}
                                className="bg-[#2D2D2D] border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-google-blue outline-none"
                             />
                        </div>
                    </div>

                    {/* User Filter & Actions */}
                    <div className="flex flex-col md:flex-row gap-4 w-full xl:w-auto">
                        <div className="relative group min-w-[200px]">
                            <select
                                value={selectedUser}
                                onChange={(e) => setSelectedUser(e.target.value)}
                                className="w-full appearance-none bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-2.5 text-sm text-white focus:ring-2 focus:ring-google-blue outline-none cursor-pointer"
                            >
                                <option value="all">All Users ({uniqueUsers.length})</option>
                                {uniqueUsers.map(u => (
                                    <option key={u} value={u}>{u.substring(0, 8)}...</option>
                                ))}
                            </select>
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                            </div>
                        </div>

                        <button 
                            onClick={() => fetchData()}
                            className="bg-google-blue hover:bg-google-blueHover text-gray-900 px-6 py-2 rounded-lg font-bold text-sm shadow-md transition-colors flex items-center justify-center gap-2"
                        >
                            {loading ? <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div> : 'Refesh Data'}
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mb-8 p-4 bg-red-900/30 border border-red-700/50 text-red-200 rounded-xl">
                    Error loading data: {error}
                </div>
            )}

            {/* --- Analytics Scorecards --- */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8">
                <Scorecard title="Model Gens" value={stats.totalGenerations} subtext="Total Requests" />
                <Scorecard title="Scripts" value={stats.scriptCount} subtext="Text Gen" color="text-google-blue" />
                <Scorecard title="Avatars" value={stats.avatarCount} subtext="Image Gen" color="text-google-yellow" />
                <Scorecard title="Video Clips" value={stats.videoCount} subtext="Veo Gen" color="text-google-green" />
                <Scorecard title="Users" value={stats.totalUsers} subtext="Active in Range" />
                <Scorecard title="Gamerheads" value={stats.exportCount} subtext="Videos Produced" color="text-purple-400" />
                <Scorecard 
                    title="H : V Ratio" 
                    value={`${stats.ratioHorizontal}:${stats.ratioVertical}`} 
                    subtext="Aspect Ratio" 
                    isText 
                />
            </div>

            {/* --- Charts --- */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
                {/* Activity Trend */}
                <div className="lg:col-span-2 bg-google-surface p-6 rounded-2xl border border-gray-700 h-[400px]">
                    <h3 className="text-white font-bold mb-6 flex items-center gap-2">
                        <span className="text-xl">📈</span> Activity Trends
                    </h3>
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={stats.dailyActivity}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#444" vertical={false} />
                            <XAxis dataKey="date" stroke="#888" fontSize={12} tickFormatter={val => val.slice(5)} />
                            <YAxis stroke="#888" fontSize={12} />
                            <Tooltip 
                                contentStyle={{ backgroundColor: '#1E1E1E', borderColor: '#444', color: '#fff' }} 
                                itemStyle={{ color: '#fff' }}
                            />
                            <Legend />
                            {modelKeys.map((key, index) => (
                                <Line 
                                    key={key}
                                    type="monotone" 
                                    dataKey={key} 
                                    stroke={colors[index % colors.length]} 
                                    strokeWidth={3}
                                    dot={false}
                                    activeDot={{ r: 6 }}
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>

                {/* Model Usage */}
                <div className="bg-google-surface p-6 rounded-2xl border border-gray-700 h-[400px]">
                     <h3 className="text-white font-bold mb-6 flex items-center gap-2">
                        <span className="text-xl">📊</span> Model Usage
                    </h3>
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stats.modelUsage} layout="vertical">
                            <CartesianGrid strokeDasharray="3 3" stroke="#444" horizontal={false} />
                            <XAxis type="number" stroke="#888" fontSize={12} />
                            <YAxis dataKey="name" type="category" stroke="#888" fontSize={10} width={100} />
                            <Tooltip cursor={{fill: 'transparent'}} contentStyle={{ backgroundColor: '#1E1E1E', borderColor: '#444', color: '#fff' }} />
                            <Bar dataKey="count" fill="#81C995" radius={[0, 4, 4, 0]} barSize={20} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* --- Data Table --- */}
            <div className="bg-google-surface rounded-2xl border border-gray-700 overflow-hidden shadow-card">
                <div className="px-6 py-5 border-b border-gray-700 flex justify-between items-center">
                    <h3 className="text-white font-bold text-lg">Activity Log</h3>
                    <button 
                        onClick={handleExportCSV}
                        className="text-xs font-bold text-google-blue hover:text-white transition-colors flex items-center gap-2 bg-blue-900/20 px-3 py-1.5 rounded-lg border border-blue-900/50 hover:bg-blue-900/40"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        Download CSV
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-gray-400">
                        <thead className="bg-[#121212] text-xs uppercase font-bold text-gray-500">
                            <tr>
                                {[
                                    { label: 'Time', key: 'timestamp' },
                                    { label: 'User ID', key: 'userId' },
                                    { label: 'Type', key: 'type' },
                                    { label: 'Model', key: 'model' },
                                    { label: 'Status', key: 'status' }
                                ].map((col) => (
                                    <th 
                                        key={col.key}
                                        className="px-6 py-4 cursor-pointer hover:text-white transition-colors select-none"
                                        onClick={() => handleSort(col.key as keyof LogEntry)}
                                    >
                                        <div className="flex items-center gap-1">
                                            {col.label}
                                            {sortConfig.key === col.key && (
                                                <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                                            )}
                                        </div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-700">
                            {sortedLogs.slice(0, 100).map((log, i) => (
                                <tr key={i} className="hover:bg-white/5 transition-colors group">
                                    <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500 font-mono">
                                        {new Date(log.timestamp).toLocaleString()}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-xs text-gray-400 group-hover:text-white">
                                        {log.userId.slice(0, 8)}...
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                                            log.type === 'video' ? 'bg-purple-900/30 text-purple-300' :
                                            log.type === 'image' ? 'bg-blue-900/30 text-blue-300' :
                                            log.type === 'export' ? 'bg-green-900/30 text-green-300' :
                                            'bg-gray-700 text-gray-300'
                                        }`}>
                                            {log.type}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-xs font-medium text-gray-300">
                                        {log.model.replace('gemini-','').replace('veo-','')}
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <div className={`w-2 h-2 rounded-full ${log.status === 'success' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                            <span className={`text-xs font-bold ${log.status === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                                                {log.status.toUpperCase()}
                                            </span>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {sortedLogs.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-12 text-center text-gray-600">
                                        No activity found for the selected period.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {sortedLogs.length > 100 && (
                    <div className="px-6 py-3 bg-[#121212] text-center text-xs text-gray-500 border-t border-gray-700">
                        Showing first 100 of {sortedLogs.length} logs
                    </div>
                )}
            </div>
        </div>
    );
};

// Simple Scorecard Component
const Scorecard: React.FC<{ title: string; value: number | string; subtext: string; color?: string; isText?: boolean }> = ({ 
    title, value, subtext, color = "text-white", isText 
}) => (
    <div className="bg-google-surface p-5 rounded-xl border border-gray-700 shadow-sm flex flex-col justify-between h-32 hover:border-gray-500 transition-colors">
        <h3 className="text-gray-500 text-[10px] font-bold uppercase tracking-wider mb-1">{title}</h3>
        <p className={`font-black ${color} ${isText ? 'text-2xl' : 'text-4xl'}`}>
            {value}
        </p>
        <p className="text-gray-500 text-xs mt-2 font-medium">{subtext}</p>
    </div>
);

export default AdminDashboard;
