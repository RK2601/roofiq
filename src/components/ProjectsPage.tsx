import { useEffect, useState } from 'react';
import { MapPin, FolderOpen, Eye } from 'lucide-react';
import { getRecentProjects } from '../utils/db';
import ProjectDetailModal from './ProjectDetailModal';

interface ProjectsPageProps {
  onNewAnalysis: () => void;
}

interface Project {
  id: string;
  address: string;
  lat: number;
  lng: number;
  snapshot_url: string | null;
  created_at: string;
  section_count: number;
  total_area: number;
}

export default function ProjectsPage({ onNewAnalysis }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getRecentProjects(50)
      .then(rows => setProjects(rows as Project[]))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Projects</h2>
            {!loading && (
              <p className="text-slate-500 text-sm mt-1">
                Showing {projects.length} project{projects.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <button
            onClick={onNewAnalysis}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors"
          >
            <MapPin size={16} />
            New Analysis
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="animate-pulse">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="px-6 py-4 border-b border-slate-100 flex items-center gap-4">
                  <div className="h-4 bg-slate-200 rounded w-6" />
                  <div className="h-4 bg-slate-200 rounded flex-1" />
                  <div className="h-4 bg-slate-200 rounded w-16" />
                  <div className="h-4 bg-slate-200 rounded w-24" />
                  <div className="h-4 bg-slate-200 rounded w-24" />
                  <div className="w-20 h-12 bg-slate-200 rounded" />
                  <div className="h-8 bg-slate-200 rounded w-16" />
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="p-16 text-center">
              <FolderOpen size={48} className="text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500 font-semibold text-lg">No projects yet</p>
              <p className="text-slate-400 text-sm mt-2 mb-6">
                Start a new analysis to create your first project.
              </p>
              <button
                onClick={onNewAnalysis}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
              >
                <MapPin size={16} />
                New Analysis
              </button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10">#</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Sections</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Area</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Preview</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {projects.map((p, idx) => (
                  <tr
                    key={p.id}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => setSelectedId(p.id)}
                  >
                    <td className="px-6 py-3 text-slate-400">{idx + 1}</td>
                    <td className="px-6 py-3 font-medium text-slate-800 max-w-xs">
                      <span className="block truncate">{p.address}</span>
                    </td>
                    <td className="px-6 py-3 text-right text-slate-600">{p.section_count}</td>
                    <td className="px-6 py-3 text-right text-slate-600">
                      {p.total_area.toLocaleString('en-US', { maximumFractionDigits: 0 })} sq ft
                    </td>
                    <td className="px-6 py-3 text-right text-slate-400">
                      {new Date(p.created_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </td>
                    <td className="px-6 py-3 text-center">
                      {p.snapshot_url ? (
                        <img
                          src={p.snapshot_url}
                          alt={p.address}
                          className="w-20 h-12 object-cover rounded mx-auto border border-slate-200"
                        />
                      ) : (
                        <div className="w-20 h-12 bg-slate-100 rounded mx-auto flex items-center justify-center border border-slate-200">
                          <MapPin size={16} className="text-slate-300" />
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3 text-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setSelectedId(p.id)}
                        className="inline-flex items-center gap-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <Eye size={13} />
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!loading && projects.length > 0 && (
          <p className="text-slate-400 text-xs mt-3">
            Showing {projects.length} of {projects.length} projects
          </p>
        )}
      </div>

      {selectedId && (
        <ProjectDetailModal
          projectId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}
