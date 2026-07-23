import React, { useState, useEffect, useRef } from 'react';
import { 
  getClasses, saveClass, deleteClass, validateStudentLogin, isFirebaseConfigured,
  getSubjects, saveSubject, deleteSubject, getProfessors, saveProfessor, deleteProfessor, validateProfessorLogin,
  getFirestoreDb, getAttendanceLogs, saveAttendanceEntry, updateAttendanceExit, getAllAttendanceLogs,
  deleteAttendanceLog, updateAttendanceLog, getAdjustments, saveAdjustment, deleteAdjustment
} from './db';
import { collection, onSnapshot } from 'firebase/firestore';
import { drawStylishQR } from './qrHelper';
import { Html5Qrcode } from 'html5-qrcode';

// ===================================================
// PURE UTILITY HELPER FUNCTIONS
// ===================================================

/** Convert "HH:MM" string to total minutes from midnight */
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
};

/** Format minutes-from-midnight to "HH:MM AM/PM" */
const minutesToDisplay = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${m.toString().padStart(2, '0')} ${ampm}`;
};

/** Format an ISO timestamp to readable time "HH:MM AM/PM" */
const formatTime = (isoStr) => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
};

/** Format an ISO timestamp to "DD MMM YYYY" */
const formatDate = (isoStr) => {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** Get today's day name e.g. "Monday" */
const getTodayDayName = () => {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' });
};

/** Get today's date as YYYY-MM-DD */
const getTodayDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

/** Get day name from YYYY-MM-DD e.g. "Monday" */
const getDayNameFromDate = (dateStr) => {
  const d = new Date(dateStr);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[d.getDay()];
};

/** Calculate distance between two coordinates using Haversine formula */
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // In meters
};

const GCECT_LAT = 22.56486;
const GCECT_LON = 88.39114;
const GCECT_RADIUS_METERS = 200;

/** Check if student current location is inside GCECT campus geofence */
const checkGeofence = () => {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by your browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const dist = calculateDistance(latitude, longitude, GCECT_LAT, GCECT_LON);
        resolve({
          inRange: dist <= GCECT_RADIUS_METERS,
          distance: Math.round(dist),
          latitude,
          longitude
        });
      },
      (error) => {
        reject(error);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
};

/** Check if a rescheduled slot overlaps with active classes */
const checkOverlapForRescheduling = (currentClass, targetDate, startStr, endStr, classAdjustments, excludePeriodId = null) => {
  const newStart = timeToMinutes(startStr);
  const newEnd = timeToMinutes(endStr);
  const dayName = getDayNameFromDate(targetDate);
  
  // 1. Check routine periods on this weekday
  const routinePeriods = currentClass.routine || [];
  const weekdayPeriods = routinePeriods.filter(p => p.day === dayName);
  
  const hasRoutineOverlap = weekdayPeriods.some(p => {
    if (excludePeriodId && p.id === excludePeriodId) return false;
    const pStart = timeToMinutes(p.startTime);
    const pEnd = timeToMinutes(p.endTime);
    const overlaps = (newStart < pEnd && newEnd > pStart);
    
    if (overlaps) {
      // Overlaps routine, check if routine period is vacated (cancelled or rescheduled away) on this date
      const isVacated = classAdjustments.some(adj => 
        adj.periodId === p.id && 
        adj.date === targetDate && 
        (adj.status === 'cancelled' || adj.status === 'rescheduled')
      );
      return !isVacated;
    }
    return false;
  });

  if (hasRoutineOverlap) return true;

  // 2. Check other rescheduled classes on this date
  const hasRescheduledOverlap = classAdjustments.some(adj => {
    if (adj.date === targetDate && adj.status === 'rescheduled') {
      if (excludePeriodId && adj.periodId === excludePeriodId) return false;
      const adjStart = timeToMinutes(adj.rescheduledStartTime);
      const adjEnd = timeToMinutes(adj.rescheduledEndTime);
      return (newStart < adjEnd && newEnd > adjStart);
    }
    return false;
  });

  return hasRescheduledOverlap;
};

export default function App() {
  // Page states
  const [currentPage, setCurrentPage] = useState('landing'); // landing | admin | student_dashboard | professor_dashboard
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [role, setRole] = useState('student'); // student | professor
  
  // Tab Routing inside Admin dashboard
  const [adminActiveTab, setAdminActiveTab] = useState('classes'); // classes | subjects_professors

  // Database states
  const [classes, setClasses] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [professors, setProfessors] = useState([]);
  
  // Authenticated states
  const [activeStudentInfo, setActiveStudentInfo] = useState(null);
  const [activeProfessorInfo, setActiveProfessorInfo] = useState(null);

  // Student dashboard states
  const [studentTab, setStudentTab] = useState('scan'); // 'scan' | 'analytics'
  const [scanState, setScanState] = useState(null); // result object from processQRScan
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [pendingEntry, setPendingEntry] = useState(null); // open un-exited record
  const [scanAnimating, setScanAnimating] = useState(false);

  // Professor dashboard states
  const [selectedProfClass, setSelectedProfClass] = useState(null);
  const [selectedProfSubject, setSelectedProfSubject] = useState(null);
  const [profSearchQuery, setProfSearchQuery] = useState('');
  const [profFilterStatus, setProfFilterStatus] = useState('all'); // all | safe | risk | danger
  const [profFilterGroup, setProfFilterGroup] = useState('all'); // all | A | B
  const [selectedProfStudent, setSelectedProfStudent] = useState(null);
  const [profAllAttendanceLogs, setProfAllAttendanceLogs] = useState([]);

  // Manual log editing states
  const [editLogId, setEditLogId] = useState(null);
  const [editEntryTime, setEditEntryTime] = useState('');
  const [editExitTime, setEditExitTime] = useState('');
  const [editStatus, setEditStatus] = useState('present');

  // Manual log creation states
  const [manualLogDate, setManualLogDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  });
  const [manualLogPeriodId, setManualLogPeriodId] = useState('');
  const [manualLogEntryTime, setManualLogEntryTime] = useState('09:00');
  const [manualLogExitTime, setManualLogExitTime] = useState('10:00');
  const [manualLogStatus, setManualLogStatus] = useState('present');

  // Subject Form states
  const [editSubjectId, setEditSubjectId] = useState(null);
  const [subjectNameInput, setSubjectNameInput] = useState('');
  const [subjectDeptInput, setSubjectDeptInput] = useState('Information Technology');
  const [subjectTypeInput, setSubjectTypeInput] = useState('Theory');

  // Professor Form states
  const [editProfessorId, setEditProfessorId] = useState(null);
  const [professorNameInput, setProfessorNameInput] = useState('');
  const [professorLoginInput, setProfessorLoginInput] = useState('');
  const [professorPasswordInput, setProfessorPasswordInput] = useState('');
  const [professorDeptInput, setProfessorDeptInput] = useState('Information Technology');
  const [professorSubjectsInput, setProfessorSubjectsInput] = useState([]);

  // Class Creator Form states
  const [editClassId, setEditClassId] = useState(null);
  const [classNameInput, setClassNameInput] = useState('');
  const [batchStartInput, setBatchStartInput] = useState('2026');
  const [batchEndInput, setBatchEndInput] = useState('2030');
  const [programInput, setProgramInput] = useState('B.Tech');
  const [semesterInput, setSemesterInput] = useState('1');
  const [studentRows, setStudentRows] = useState([]);
  const [excelPasteText, setExcelPasteText] = useState('');
  
  // Custom QR Poster states
  const [activeQRClass, setActiveQRClass] = useState(null);
  const qrCanvasRef = useRef(null);

  // Class Routine states
  const [routineList, setRoutineList] = useState([]);
  const [periodDay, setPeriodDay] = useState('Monday');
  const [periodStartTime, setPeriodStartTime] = useState('09:00');
  const [periodEndTime, setPeriodEndTime] = useState('10:00');
  const [periodType, setPeriodType] = useState('Theory');

  // Theory input states
  const [theoryDept, setTheoryDept] = useState('Information Technology');
  const [theorySubjectId, setTheorySubjectId] = useState('');
  const [theoryProf1, setTheoryProf1] = useState('');
  const [theoryProf2, setTheoryProf2] = useState('');

  // Practical input states (Separate parallel tracking for Group A and B)
  const [pracDeptA, setPracDeptA] = useState('Information Technology');
  const [pracSubjectIdA, setPracSubjectIdA] = useState('');
  const [pracProf1A, setPracProf1A] = useState('');
  const [pracProf2A, setPracProf2A] = useState('');

  const [pracDeptB, setPracDeptB] = useState('Information Technology');
  const [pracSubjectIdB, setPracSubjectIdB] = useState('');
  const [pracProf1B, setPracProf1B] = useState('');
  const [pracProf2B, setPracProf2B] = useState('');

  // Form states
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Geofencing and schedule adjustments states
  const [mockGcectLocation, setMockGcectLocation] = useState(true); // Default checked for testing
  const [geoChecking, setGeoChecking] = useState(false);
  const [classAdjustments, setClassAdjustments] = useState([]);
  const [studentAdjustments, setStudentAdjustments] = useState([]);
  
  // Reschedule/Cancel Modal states
  const [adjustmentModalPeriod, setAdjustmentModalPeriod] = useState(null);
  const [adjustmentDate, setAdjustmentDate] = useState(getTodayDate());
  const [adjustmentType, setAdjustmentType] = useState('cancelled'); // cancelled | rescheduled
  const [rescheduleDate, setRescheduleDate] = useState(getTodayDate());
  const [rescheduleStartTime, setRescheduleStartTime] = useState('09:00');
  const [rescheduleEndTime, setRescheduleEndTime] = useState('10:00');

  // Camera scanner states
  const [isScanning, setIsScanning] = useState(false);
  const [scannerError, setScannerError] = useState(null);
  const html5QrCodeRef = useRef(null);
  // Derived filtered subjects and professors for the routine builder
  const filteredTheorySubjects = subjects.filter(s => s.department === theoryDept && s.type === 'Theory');
  const filteredTheoryProfs = professors.filter(p => p.department === theoryDept && p.subjects.some(sub => sub.id === (theorySubjectId || (filteredTheorySubjects[0]?.id))));

  const filteredPracSubjectsA = subjects.filter(s => s.department === pracDeptA && s.type === 'Practical');
  const filteredPracProfsA = professors.filter(p => p.department === pracDeptA && p.subjects.some(sub => sub.id === (pracSubjectIdA || (filteredPracSubjectsA[0]?.id))));

  const filteredPracSubjectsB = subjects.filter(s => s.department === pracDeptB && s.type === 'Practical');
  const filteredPracProfsB = professors.filter(p => p.department === pracDeptB && p.subjects.some(sub => sub.id === (pracSubjectIdB || (filteredPracSubjectsB[0]?.id))));
  // Load all system data on mount and subscribe to realtime updates
  useEffect(() => {
    loadAllData();

    // Subscribe to realtime database updates if Firebase is active
    const db = getFirestoreDb();
    const unsubscribes = [];
    
    if (db) {
      try {
        const collections = ['classes', 'students', 'subjects', 'professors', 'adjustments'];
        collections.forEach(colName => {
          const unsub = onSnapshot(
            collection(db, colName),
            (snapshot) => {
              console.log(`Realtime Firestore ${colName} update received`);
              loadAllData();
            },
            (error) => {
              console.warn(`Firestore listener for ${colName} error (security rules):`, error);
            }
          );
          unsubscribes.push(unsub);
        });
      } catch (err) {
        console.warn("Failed to subscribe to Firestore collections:", err);
      }
    }

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, []);

  // Auto-align routine builder dropdown values when subjects/professors change
  useEffect(() => {
    if (subjects.length > 0) {
      if (!theorySubjectId) {
        const filtered = subjects.filter(s => s.department === theoryDept && s.type === 'Theory');
        if (filtered.length > 0) {
          setTheorySubjectId(filtered[0].id);
          const subProfs = professors.filter(p => p.department === theoryDept && p.subjects.some(sub => sub.id === filtered[0].id));
          if (subProfs.length > 0) setTheoryProf1(subProfs[0].id);
        }
      }
      if (!pracSubjectIdA) {
        const filtered = subjects.filter(s => s.department === pracDeptA && s.type === 'Practical');
        if (filtered.length > 0) {
          setPracSubjectIdA(filtered[0].id);
          const subProfs = professors.filter(p => p.department === pracDeptA && p.subjects.some(sub => sub.id === filtered[0].id));
          if (subProfs.length > 0) setPracProf1A(subProfs[0].id);
        }
      }
      if (!pracSubjectIdB) {
        const filtered = subjects.filter(s => s.department === pracDeptB && s.type === 'Practical');
        if (filtered.length > 0) {
          setPracSubjectIdB(filtered[0].id);
          const subProfs = professors.filter(p => p.department === pracDeptB && p.subjects.some(sub => sub.id === filtered[0].id));
          if (subProfs.length > 0) setPracProf1B(subProfs[0].id);
        }
      }
    }
  }, [subjects, professors, theoryDept, pracDeptA, pracDeptB]);

  // Redraw stylish QR code on activeQRClass canvas mount/refresh
  useEffect(() => {
    if (activeQRClass && qrCanvasRef.current) {
      drawStylishQR(`attendx://mark-attendance?classId=${activeQRClass.id}`, qrCanvasRef.current, { width: 360 });
    }
  }, [activeQRClass]);

  const handleTheoryDeptChange = (dept) => {
    setTheoryDept(dept);
    const subList = subjects.filter(s => s.department === dept && s.type === 'Theory');
    if (subList.length > 0) {
      setTheorySubjectId(subList[0].id);
      const profList = professors.filter(p => p.department === dept && p.subjects.some(sub => sub.id === subList[0].id));
      setTheoryProf1(profList.length > 0 ? profList[0].id : '');
      setTheoryProf2('');
    } else {
      setTheorySubjectId('');
      setTheoryProf1('');
      setTheoryProf2('');
    }
  };

  const handleTheorySubjectChange = (subId) => {
    setTheorySubjectId(subId);
    const profList = professors.filter(p => p.department === theoryDept && p.subjects.some(sub => sub.id === subId));
    setTheoryProf1(profList.length > 0 ? profList[0].id : '');
    setTheoryProf2('');
  };

  const handlePracDeptAChange = (dept) => {
    setPracDeptA(dept);
    const subList = subjects.filter(s => s.department === dept && s.type === 'Practical');
    if (subList.length > 0) {
      setPracSubjectIdA(subList[0].id);
      const profList = professors.filter(p => p.department === dept && p.subjects.some(sub => sub.id === subList[0].id));
      setPracProf1A(profList.length > 0 ? profList[0].id : '');
      setPracProf2A('');
    } else {
      setPracSubjectIdA('');
      setPracProf1A('');
      setPracProf2A('');
    }
  };

  const handlePracSubjectAChange = (subId) => {
    setPracSubjectIdA(subId);
    const profList = professors.filter(p => p.department === pracDeptA && p.subjects.some(sub => sub.id === subId));
    setPracProf1A(profList.length > 0 ? profList[0].id : '');
    setPracProf2A('');
  };

  const handlePracDeptBChange = (dept) => {
    setPracDeptB(dept);
    const subList = subjects.filter(s => s.department === dept && s.type === 'Practical');
    if (subList.length > 0) {
      setPracSubjectIdB(subList[0].id);
      const profList = professors.filter(p => p.department === dept && p.subjects.some(sub => sub.id === subList[0].id));
      setPracProf1B(profList.length > 0 ? profList[0].id : '');
      setPracProf2B('');
    } else {
      setPracSubjectIdB('');
      setPracProf1B('');
      setPracProf2B('');
    }
  };

  const handlePracSubjectBChange = (subId) => {
    setPracSubjectIdB(subId);
    const profList = professors.filter(p => p.department === pracDeptB && p.subjects.some(sub => sub.id === subId));
    setPracProf1B(profList.length > 0 ? profList[0].id : '');
    setPracProf2B('');
  };

  const loadAllData = async () => {
    const classData = await getClasses();
    setClasses(classData || []);
    
    const subjectsData = await getSubjects();
    setSubjects(subjectsData || []);

    const professorsData = await getProfessors();
    setProfessors(professorsData || []);

    setProfAllAttendanceLogs(await getAllAttendanceLogs());
  };

  // Monitor scroll for navbar styles
  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 30) {
        setScrolled(true);
      } else {
        setScrolled(false);
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeLoginModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Realtime Firebase Database Change Listener
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;

    const unsubscribeLogs = onSnapshot(
      collection(db, 'attendance'),
      async (snapshot) => {
        console.log("Firebase Realtime database change detected");
        
        if (currentPage === 'professor_dashboard' || currentPage === 'admin') {
          const allLogs = await getAllAttendanceLogs();
          setProfAllAttendanceLogs(allLogs);
          
          if (selectedProfStudent && selectedProfClass) {
            const currentClass = classes.find(c => c.id === selectedProfClass.id);
            let classSubjects = [];
            const routine = currentClass?.routine || [];
            routine.forEach(p => {
              if (p.type === 'Theory') {
                classSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
              } else {
                if (p.groupA) classSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
                if (p.groupB) classSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
              }
            });
            const currentSub = selectedProfSubject || (classSubjects.length > 0 ? classSubjects[0] : null);
            if (currentSub) {
              await refreshSelectedStudentLogs(selectedProfStudent.id, selectedProfClass.id, currentSub);
            }
          }
        } else if (currentPage === 'student_dashboard' && activeStudentInfo) {
          await refreshAttendanceLogs(activeStudentInfo.student.id);
        }
      },
      (error) => {
        console.warn("Firestore realtime snapshot listener error (check security rules):", error);
      }
    );

    const unsubscribeAdjustments = onSnapshot(
      collection(db, 'adjustments'),
      async (snapshot) => {
        console.log("Firebase Realtime adjustments update received");
        if (selectedProfClass) {
          const adjs = await getAdjustments(selectedProfClass.id);
          setClassAdjustments(adjs);
        }
        if (activeStudentInfo) {
          const adjs = await getAdjustments(activeStudentInfo.classId);
          setStudentAdjustments(adjs);
        }
      },
      (error) => {
        console.warn("Firestore adjustments listener error:", error);
      }
    );

    return () => {
      unsubscribeLogs();
      unsubscribeAdjustments();
    };
  }, [currentPage, activeStudentInfo, selectedProfStudent, selectedProfClass, selectedProfSubject, classes]);

  useEffect(() => {
    const fetchClassAdjustments = async () => {
      if (selectedProfClass) {
        const adjs = await getAdjustments(selectedProfClass.id);
        setClassAdjustments(adjs);
      } else {
        setClassAdjustments([]);
      }
    };
    fetchClassAdjustments();
  }, [selectedProfClass]);

  const openLoginModal = (initialRole = 'student') => {
    setRole(initialRole);
    setModalOpen(true);
    setUserId('');
    setPassword('');
    setPasswordVisible(false);
    document.body.style.overflow = 'hidden';
  };

  const closeLoginModal = () => {
    setModalOpen(false);
    document.body.style.overflow = '';
  };

  const switchRole = (newRole) => {
    setRole(newRole);
    setUserId('');
    setPassword('');
    setPasswordVisible(false);
  };

  const triggerToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 3500);
  };

  // ===================================================
  // ATTENDANCE PERIOD DETECTION ENGINE
  // ===================================================

  /**
   * Core period resolution. Given a routine and the current time, returns:
   * { type: 'current' | 'exit_window' | 'upcoming' | 'none', period, nextPeriod, nowMinutes }
   */
  const resolveCurrentPeriod = (routine, studentGroup, adjustments = []) => {
    const todayDay = getTodayDayName();
    const todayDate = getTodayDate();
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // 1. Get today's scheduled routine periods
    let activePeriods = [];
    
    // Find weekday routine periods
    const routinePeriods = routine.filter(p => p.day === todayDay);
    
    routinePeriods.forEach(p => {
      // Check if there is an adjustment (cancel or reschedule) for this routine period on this date
      const adj = adjustments.find(a => a.periodId === p.id && a.date === todayDate);
      if (adj) {
        if (adj.status === 'cancelled' || adj.status === 'rescheduled') {
          // Vacated/removed from original slot today
          return;
        }
      }
      // Running normally
      activePeriods.push(p);
    });

    // 2. Add classes rescheduled INTO today
    const incomingReschedules = adjustments.filter(a => a.rescheduledDate === todayDate && a.status === 'rescheduled');
    incomingReschedules.forEach(adj => {
      // Find the base routine period info
      const basePeriod = routine.find(p => p.id === adj.periodId);
      if (basePeriod) {
        const rescheduledPeriod = {
          ...basePeriod,
          startTime: adj.rescheduledStartTime,
          endTime: adj.rescheduledEndTime,
          isRescheduled: true,
          adjustmentId: adj.id
        };
        activePeriods.push(rescheduledPeriod);
      }
    });

    // 3. Filter by student group (if Practical)
    const relevantPeriods = activePeriods.filter(p => {
      if (p.type === 'Practical') {
        return p.groupA || p.groupB;
      }
      return true;
    });

    // 4. Sort by start time
    relevantPeriods.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    let currentPeriod = null;
    let nextPeriod = null;
    let exitWindowPeriod = null;

    for (let i = 0; i < relevantPeriods.length; i++) {
      const p = relevantPeriods[i];
      const startMin = timeToMinutes(p.startTime);
      const endMin = timeToMinutes(p.endTime);
      const exitOpenMin = endMin - 5; // Exit window opens 5 min before end

      // Is now within the main attendance window? (can enter up to endTime - 5min)
      if (nowMinutes >= startMin - 15 && nowMinutes < exitOpenMin) {
        currentPeriod = p;
        nextPeriod = relevantPeriods[i + 1] || null;
        break;
      }

      // Is now in the exit window? (last 5 min or after end, same day)
      if (nowMinutes >= exitOpenMin && nowMinutes <= endMin + 15) {
        exitWindowPeriod = p;
        nextPeriod = relevantPeriods[i + 1] || null;
        break;
      }

      // Is the next period upcoming?
      if (nowMinutes < startMin - 15) {
        nextPeriod = p;
        break;
      }
    }

    return { currentPeriod, exitWindowPeriod, nextPeriod, nowMinutes, todayPeriods: relevantPeriods };
  };

  /** Extract the subject info for a period, accounting for Practical groups */
  const getPeriodSubjectInfo = (period, studentGroup) => {
    if (!period) return null;
    if (period.type === 'Theory') {
      return {
        subjectName: period.subjectName,
        subjectId: period.subjectId,
        professors: period.professors,
        type: 'Theory',
        dept: period.dept
      };
    } else {
      // Practical — use the student's group
      const grp = studentGroup === 'B' ? period.groupB : period.groupA;
      if (!grp) return null;
      return {
        subjectName: grp.subjectName,
        subjectId: grp.subjectId,
        professors: grp.professors,
        type: 'Practical',
        dept: grp.dept,
        group: studentGroup
      };
    }
  };

  /** Load attendance logs for student and derive pendingEntry */
  const refreshAttendanceLogs = async (studentId, optionalClassId = null) => {
    const logs = await getAttendanceLogs(studentId);
    setAttendanceLogs(logs);

    const classId = optionalClassId || (activeStudentInfo ? activeStudentInfo.classId : null);
    if (classId) {
      const adjs = await getAdjustments(classId);
      setStudentAdjustments(adjs);
    }

    // Find any open entry (same day, no exit)
    const today = getTodayDate();
    const openEntry = logs.find(r => r.date === today && !r.exitTime && r.status === 'pending');
    setPendingEntry(openEntry || null);
    return { logs, openEntry: openEntry || null };
  };

  /**
   * Main QR scan processor — called when student taps "Scan QR".
   * Returns a scanResult object that drives the UI.
   */
  const processQRScan = async (qrData, studentInfo) => {
    // Parse classId from QR payload: "attendx://mark-attendance?classId=<id>"
    let scannedClassId = null;
    try {
      const url = new URL(qrData.replace('attendx://', 'https://attendx.local/'));
      scannedClassId = url.searchParams.get('classId');
    } catch {
      scannedClassId = null;
    }

    if (!scannedClassId) {
      return { type: 'error', message: 'Invalid QR code. Please scan the correct class QR poster.' };
    }

    if (scannedClassId !== studentInfo.classId) {
      return { type: 'error', message: 'This QR code belongs to a different class. Please scan your own class QR.' };
    }

    const today = getTodayDate();
    const now = new Date();
    const nowISO = now.toISOString();
    const studentId = studentInfo.student.id;
    const studentGroup = studentInfo.student.group;
    const { routine } = studentInfo;

    // Refresh logs to get latest state
    const { openEntry } = await refreshAttendanceLogs(studentId);

    // === CASE: PENDING ENTRY EXISTS (EXIT SCAN) ===
    if (openEntry) {
      const periodEnd = timeToMinutes(openEntry.periodEnd);
      const exitOpenMin = periodEnd - 5;
      const nowMin = now.getHours() * 60 + now.getMinutes();

      // Check same-day restriction
      if (openEntry.date !== today) {
        return {
          type: 'blocked',
          icon: '🚫',
          title: 'Exit Not Allowed',
          message: `Your entry for "${openEntry.subjectName}" was recorded on ${openEntry.date}. Exit must be scanned the same day. Attendance for that class cannot be marked.`,
          subMessage: 'You may now scan for today\'s classes.',
          action: 'force_close_stale'
        };
      }

      // Check if exit window is open
      if (nowMin < exitOpenMin) {
        return {
          type: 'too_early_exit',
          icon: '⏳',
          title: 'Exit Not Available Yet',
          message: `You entered "${openEntry.subjectName}". Exit scanning opens at ${minutesToDisplay(exitOpenMin)}.`,
          subMessage: `The class ends at ${minutesToDisplay(periodEnd)}. Please wait until ${minutesToDisplay(exitOpenMin)} to scan again.`,
          currentSubject: openEntry.subjectName,
          exitOpenTime: minutesToDisplay(exitOpenMin),
          entryTime: formatTime(openEntry.entryTime)
        };
      }

      // EXIT ALLOWED — record exit
      const updated = await updateAttendanceExit(openEntry.id, nowISO, 'present');
      await refreshAttendanceLogs(studentId);

      const duration = Math.round((now - new Date(openEntry.entryTime)) / 60000);

      return {
        type: 'exit_success',
        icon: '✅',
        title: 'Attendance Confirmed!',
        message: `Your attendance for "${openEntry.subjectName}" has been recorded.`,
        subjectName: openEntry.subjectName,
        entryTime: formatTime(openEntry.entryTime),
        exitTime: formatTime(nowISO),
        duration: `${duration} min`,
        date: formatDate(nowISO)
      };
    }

    // === CASE: NO PENDING ENTRY (ENTRY SCAN) ===
    const { currentPeriod, exitWindowPeriod, nextPeriod, nowMinutes, todayPeriods } = resolveCurrentPeriod(routine, studentGroup, studentAdjustments);

    // Check: is there a stale open entry from a PREVIOUS day?
    // (handled above but double-check for safety)

    // Find if there was any entry today that has no exit (edge case duplicate)
    const todayLogs = (await getAttendanceLogs(studentId)).filter(r => r.date === today);
    const hasUnclosed = todayLogs.find(r => !r.exitTime && r.status === 'pending');
    if (hasUnclosed) {
      // redundant but safety net
      setPendingEntry(hasUnclosed);
      return {
        type: 'blocked_exit_pending',
        icon: '⚠️',
        title: 'Exit Previous Class First',
        message: `You have an open entry for "${hasUnclosed.subjectName}". Please exit that class first before entering a new one.`,
        subMessage: `Exit opens at ${minutesToDisplay(timeToMinutes(hasUnclosed.periodEnd) - 5)}.`
      };
    }

    // --- No period is running right now ---
    if (!currentPeriod && !exitWindowPeriod) {
      if (nextPeriod) {
        const subInfo = getPeriodSubjectInfo(nextPeriod, studentGroup);
        const nextStart = timeToMinutes(nextPeriod.startTime);
        const minsUntilEntry = nextStart - 15 - nowMinutes;

        // If within 15-min early window, pre-record entry
        if (nowMinutes >= nextStart - 15 && nowMinutes < nextStart) {
          const subjectInfo = subInfo || { subjectName: 'Unknown Subject', subjectId: '', professors: [] };
          const record = {
            studentId,
            classId: scannedClassId,
            periodId: nextPeriod.id,
            subjectName: subjectInfo.subjectName,
            subjectId: subjectInfo.subjectId,
            periodStart: nextPeriod.startTime,
            periodEnd: nextPeriod.endTime,
            date: today,
            entryTime: nowISO,
            exitTime: null,
            status: 'pending'
          };
          const saved = await saveAttendanceEntry(record);
          await refreshAttendanceLogs(studentId);
          return {
            type: 'entry_early',
            icon: '🕐',
            title: 'Early Arrival',
            message: `You're ${nextStart - nowMinutes} minutes early! Entry recorded for "${subjectInfo.subjectName}".`,
            subMessage: `Class starts at ${minutesToDisplay(nextStart)}. Remember to scan again when the class ends.`,
            subjectName: subjectInfo.subjectName,
            periodTime: `${minutesToDisplay(timeToMinutes(nextPeriod.startTime))} – ${minutesToDisplay(timeToMinutes(nextPeriod.endTime))}`,
            entryTime: formatTime(nowISO),
            professors: subjectInfo.professors?.map(p => p.name).join(', ')
          };
        }

        return {
          type: 'no_class_now',
          icon: '📅',
          title: 'No Active Class Right Now',
          message: `Your next class is "${(subInfo || {}).subjectName || nextPeriod.type}" at ${minutesToDisplay(timeToMinutes(nextPeriod.startTime))}.`,
          subMessage: `Entry scanning opens 15 minutes before class starts, at ${minutesToDisplay(timeToMinutes(nextPeriod.startTime) - 15)}.`
        };
      }

      return {
        type: 'no_class_today',
        icon: '🎉',
        title: 'No More Classes Today',
        message: `You have no more scheduled classes for today (${getTodayDayName()}).`,
        subMessage: 'Check your routine to see tomorrow\'s schedule.'
      };
    }

    // --- Currently in exit window but no entry for this period ---
    if (exitWindowPeriod && !currentPeriod) {
      // Student wants to enter a class that's about to end — record for this period
      const subInfo = getPeriodSubjectInfo(exitWindowPeriod, studentGroup);
      if (subInfo) {
        const record = {
          studentId,
          classId: scannedClassId,
          periodId: exitWindowPeriod.id,
          subjectName: subInfo.subjectName,
          subjectId: subInfo.subjectId,
          periodStart: exitWindowPeriod.startTime,
          periodEnd: exitWindowPeriod.endTime,
          date: today,
          entryTime: nowISO,
          exitTime: null,
          status: 'pending'
        };
        const saved = await saveAttendanceEntry(record);
        await refreshAttendanceLogs(studentId);
        return {
          type: 'entry_late_exit_window',
          icon: '⚠️',
          title: 'Late Entry – Exit Window Open',
          message: `You entered "${subInfo.subjectName}" during the exit window. Scan again immediately to confirm your attendance.`,
          subMessage: 'Class ends soon. Please re-scan immediately to lock in your attendance.',
          subjectName: subInfo.subjectName,
          entryTime: formatTime(nowISO)
        };
      }
    }

    // --- Currently in active period → ENTRY ---
    if (currentPeriod) {
      const subInfo = getPeriodSubjectInfo(currentPeriod, studentGroup);
      if (!subInfo) {
        return { type: 'error', message: 'Could not resolve subject for your group. Contact admin.' };
      }

      // Check if student is arriving after some OTHER class ended today
      const lastPeriodIdx = todayPeriods.findIndex(p => p.id === currentPeriod.id);
      const prevPeriod = lastPeriodIdx > 0 ? todayPeriods[lastPeriodIdx - 1] : null;
      let latePrevMessage = null;

      if (prevPeriod) {
        const prevEnd = timeToMinutes(prevPeriod.endTime);
        // If entering current class but current class started less than 0 min ago
        // and there was a previous class — check if student entered very close to boundary
        if (nowMinutes >= timeToMinutes(currentPeriod.startTime) - 15 && nowMinutes <= timeToMinutes(currentPeriod.startTime)) {
          const prevSubInfo = getPeriodSubjectInfo(prevPeriod, studentGroup);
          const prevName = prevSubInfo?.subjectName || prevPeriod.type;
          latePrevMessage = `You were late for "${prevName}" (${minutesToDisplay(timeToMinutes(prevPeriod.startTime))}–${minutesToDisplay(prevEnd)}). Attendance for that class has NOT been counted.`;
        }
      }

      const record = {
        studentId,
        classId: scannedClassId,
        periodId: currentPeriod.id,
        subjectName: subInfo.subjectName,
        subjectId: subInfo.subjectId,
        periodStart: currentPeriod.startTime,
        periodEnd: currentPeriod.endTime,
        date: today,
        entryTime: nowISO,
        exitTime: null,
        status: 'pending'
      };
      const saved = await saveAttendanceEntry(record);
      await refreshAttendanceLogs(studentId);

      return {
        type: 'entry_success',
        icon: '🚀',
        title: 'Entry Recorded!',
        message: latePrevMessage 
          ? `Note: ${latePrevMessage} Your entry for "${subInfo.subjectName}" has been recorded.`
          : `You are entering "${subInfo.subjectName}". Attendance will be confirmed when you exit.`,
        latePrevMessage,
        subjectName: subInfo.subjectName,
        periodTime: `${minutesToDisplay(timeToMinutes(currentPeriod.startTime))} – ${minutesToDisplay(timeToMinutes(currentPeriod.endTime))}`,
        exitOpenTime: minutesToDisplay(timeToMinutes(currentPeriod.endTime) - 5),
        entryTime: formatTime(nowISO),
        professors: subInfo.professors?.map(p => p.name).join(', '),
        type_label: subInfo.type,
        dept: subInfo.dept
      };
    }

    return { type: 'error', message: 'Could not determine current class. Try again or contact admin.' };
  };

  /** Start standard camera-based QR scanner using html5-qrcode */
  const startCameraScanner = async () => {
    setScannerError(null);
    setIsScanning(true);

    // Wait for the reader element to mount
    setTimeout(() => {
      try {
        const html5QrCode = new Html5Qrcode("reader");
        html5QrCodeRef.current = html5QrCode;

        html5QrCode.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 }
          },
          async (qrMessage) => {
            await handleSuccessfulScan(qrMessage);
          },
          (err) => {
            // Silent debug failures
          }
        ).catch(err => {
          console.error("Camera start error:", err);
          setScannerError("Camera permission denied or no camera found. Please verify permissions.");
        });
      } catch (err) {
        console.error("Scanner setup failed:", err);
        setScannerError("Failed to initialize scanner. Try refreshing the page.");
      }
    }, 120);
  };

  /** Stop the camera QR scanner stream */
  const stopCameraScanner = async () => {
    if (html5QrCodeRef.current && html5QrCodeRef.current.isScanning) {
      try {
        await html5QrCodeRef.current.stop();
      } catch (err) {
        console.error("Failed to stop scanner:", err);
      }
    }
    html5QrCodeRef.current = null;
    setIsScanning(false);
  };

  /** Handle successfully parsed scanned QR text */
  const handleSuccessfulScan = async (qrMessage) => {
    // 1. Instantly stop the camera feed
    await stopCameraScanner();

    // 2. Animate and check geofence range
    setScanAnimating(true);
    setGeoChecking(true);

    try {
      let geoResult = { inRange: true, distance: 0 };
      if (!mockGcectLocation) {
        geoResult = await checkGeofence();
      }

      setScanAnimating(false);
      setGeoChecking(false);

      if (!geoResult.inRange) {
        setScanState({
          type: 'geo_error',
          icon: '📍',
          title: 'Out of Campus Range',
          message: `You are currently ${geoResult.distance} meters away from the GCECT campus.`,
          subMessage: `Attendance scans are restricted to GCECT campus radius (200m). Please scan inside the campus.`
        });
        return;
      }

      // 3. Process the scanned QR data payload
      const result = await processQRScan(qrMessage, activeStudentInfo);
      setScanState(result);
    } catch (err) {
      setScanAnimating(false);
      setGeoChecking(false);
      setScanState({
        type: 'geo_error',
        icon: '📍',
        title: 'Location Access Required',
        message: 'Could not access your location. Please grant GPS permission to verify you are on campus.',
        subMessage: err.message || 'Location lookup timed out.'
      });
    }
  };

  /** Handle the simulate-scan button press */
  const handleSimulateScan = async () => {
    if (!activeStudentInfo) return;
    setScanAnimating(true);
    setGeoChecking(true);
    
    try {
      let geoResult = { inRange: true, distance: 0 };
      
      if (!mockGcectLocation) {
        geoResult = await checkGeofence();
      }
      
      setTimeout(async () => {
        setScanAnimating(false);
        setGeoChecking(false);
        
        if (!geoResult.inRange) {
          setScanState({
            type: 'geo_error',
            icon: '📍',
            title: 'Out of Campus Range',
            message: `You are currently ${geoResult.distance} meters away from the GCECT campus.`,
            subMessage: `Attendance scans are restricted to GCECT campus radius (200m). Please scan inside the campus.`
          });
          return;
        }

        const qrData = `attendx://mark-attendance?classId=${activeStudentInfo.classId}`;
        const result = await processQRScan(qrData, activeStudentInfo);
        setScanState(result);
      }, 1200);
    } catch (err) {
      setScanAnimating(false);
      setGeoChecking(false);
      setScanState({
        type: 'geo_error',
        icon: '📍',
        title: 'Location Access Required',
        message: 'Could not access your location. Please grant GPS permission to verify you are on campus.',
        subMessage: err.message || 'Location lookup timed out.'
      });
    }
  };

  /** Force-close a stale previous-day entry */
  const handleForceCloseStalePending = async () => {
    if (!pendingEntry) return;
    // Mark as absent (no exit recorded)
    await updateAttendanceExit(pendingEntry.id, null, 'absent_no_exit');
    await refreshAttendanceLogs(activeStudentInfo.student.id);
    setScanState(null);
    triggerToast('Stale entry cleared. You can now scan for today\'s class.', 'success');
  };

  /** Reset scan state to show the scan button again */
  const handleScanAgain = async () => {
    setScanState(null);
    if (activeStudentInfo) await refreshAttendanceLogs(activeStudentInfo.student.id);
  };

  const refreshSelectedStudentLogs = async (studentId, classId, subject) => {
    const allLogs = await getAllAttendanceLogs();
    setProfAllAttendanceLogs(allLogs);

    if (selectedProfStudent && selectedProfStudent.id === studentId) {
      const classSubLogs = allLogs.filter(log => log.classId === classId && (log.subjectId === subject.id || log.subjectName === subject.name));
      const studentLogs = classSubLogs.filter(log => log.studentId === studentId);
      const attendedCount = studentLogs.filter(log => log.exitTime && log.status === 'present').length;
      
      setSelectedProfStudent(prev => {
        const pct = prev.totalExpected > 0 ? Math.round((attendedCount / prev.totalExpected) * 100) : 100;
        let status = 'safe';
        if (pct < 60) status = 'danger';
        else if (pct < 75) status = 'risk';

        return {
          ...prev,
          attendedCount,
          pct,
          status,
          logs: studentLogs
        };
      });
    }
  };

  const handleClearAllStudentLogs = async (studentId, classId, subject) => {
    try {
      const studentLogs = selectedProfStudent.logs || [];
      for (const log of studentLogs) {
        await deleteAttendanceLog(log.id);
      }
      await refreshSelectedStudentLogs(studentId, classId, subject);
      await loadAllData();
      triggerToast('All attendance logs for this student have been cleared!', 'success');
    } catch (err) {
      console.error("Failed to clear student logs:", err);
      triggerToast('Failed to clear attendance logs.', 'error');
    }
  };

  const handleAddManualLog = async (studentId, classId, subject) => {
    if (!manualLogPeriodId) {
      triggerToast('Please select a period.', 'error');
      return;
    }

    const cls = classes.find(c => c.id === classId);
    const period = cls?.routine?.find(p => p.id === manualLogPeriodId);
    if (!period) {
      triggerToast('Selected period not found.', 'error');
      return;
    }

    const subInfo = getPeriodSubjectInfo(period, selectedProfStudent.group);
    if (!subInfo) {
      triggerToast('Could not resolve subject for group.', 'error');
      return;
    }

    const entryISO = new Date(`${manualLogDate}T${manualLogEntryTime}:00`).toISOString();
    const exitISO = manualLogStatus === 'present' 
      ? new Date(`${manualLogDate}T${manualLogExitTime}:00`).toISOString()
      : null;

    const newRecord = {
      studentId,
      classId,
      periodId: period.id,
      subjectName: subInfo.subjectName,
      subjectId: subInfo.subjectId,
      periodStart: period.startTime,
      periodEnd: period.endTime,
      date: manualLogDate,
      entryTime: entryISO,
      exitTime: exitISO,
      status: manualLogStatus
    };

    await saveAttendanceEntry(newRecord);
    await refreshSelectedStudentLogs(studentId, classId, subject);
    triggerToast('Manual attendance record added successfully!', 'success');
    setManualLogPeriodId('');
  };

  const handleStartEditLog = (log) => {
    setEditLogId(log.id);
    const entryDate = new Date(log.entryTime);
    const entryH = String(entryDate.getHours()).padStart(2, '0');
    const entryM = String(entryDate.getMinutes()).padStart(2, '0');
    setEditEntryTime(`${entryH}:${entryM}`);

    if (log.exitTime) {
      const exitDate = new Date(log.exitTime);
      const exitH = String(exitDate.getHours()).padStart(2, '0');
      const exitM = String(exitDate.getMinutes()).padStart(2, '0');
      setEditExitTime(`${exitH}:${exitM}`);
    } else {
      setEditExitTime('');
    }
    setEditStatus(log.status);
  };

  const handleCancelEditLog = () => {
    setEditLogId(null);
  };

  const handleSaveEditLog = async (log, subject) => {
    const dateStr = log.date;
    const entryISO = new Date(`${dateStr}T${editEntryTime}:00`).toISOString();
    const exitISO = (editStatus === 'present' && editExitTime)
      ? new Date(`${dateStr}T${editExitTime}:00`).toISOString()
      : null;

    const updatedRecord = {
      ...log,
      entryTime: entryISO,
      exitTime: exitISO,
      status: editStatus
    };

    await updateAttendanceLog(updatedRecord);
    setEditLogId(null);
    await refreshSelectedStudentLogs(log.studentId, log.classId, subject);
    triggerToast('Attendance record updated successfully!', 'success');
  };

  const handleDeleteLog = async (logId, studentId, classId, subject) => {
    if (window.confirm('Are you sure you want to delete this attendance log?')) {
      await deleteAttendanceLog(logId);
      await refreshSelectedStudentLogs(studentId, classId, subject);
      triggerToast('Attendance record deleted successfully.', 'success');
    }
  };
  const renderClassDetailAnalytics = () => {
    const currentClass = selectedProfClass ? classes.find(c => c.id === selectedProfClass.id) : null;
    if (!currentClass) return null;

    const profId = activeProfessorInfo?.professor?.id || null;

    // Scan classes to identify taught subjects
    let classSubjects = [];
    if (currentPage === 'admin') {
      // Admin sees all subjects in class routine
      const routine = currentClass.routine || [];
      const subKeys = new Set();
      routine.forEach(p => {
        if (p.type === 'Theory') {
          if (!subKeys.has(p.subjectId)) {
            subKeys.add(p.subjectId);
            classSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
          }
        } else {
          if (p.groupA && !subKeys.has(p.groupA.subjectId)) {
            subKeys.add(p.groupA.subjectId);
            classSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
          }
          if (p.groupB && !subKeys.has(p.groupB.subjectId)) {
            subKeys.add(p.groupB.subjectId);
            classSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
          }
        }
      });
    } else {
      // Professor only sees subjects they teach
      const routine = currentClass.routine || [];
      routine.forEach(p => {
        if (p.type === 'Theory') {
          if (p.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.subjectId)) {
              classSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
            }
          }
        } else {
          if (p.groupA?.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.groupA.subjectId)) {
              classSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
            }
          }
          if (p.groupB?.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.groupB.subjectId)) {
              classSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
            }
          }
        }
      });
    }

    // Fallback if no subjects found in routine
    if (classSubjects.length === 0) {
      if (currentPage === 'admin') {
        classSubjects = subjects; // fallback to all subjects
      } else {
        classSubjects = activeProfessorInfo?.professor?.subjects || [];
      }
    }

    const currentSub = selectedProfSubject || (classSubjects.length > 0 ? classSubjects[0] : null);

    // Filter logs for this class and subject
    const classSubLogs = currentSub
      ? profAllAttendanceLogs.filter(log => log.classId === currentClass.id && (log.subjectId === currentSub.id || log.subjectName === currentSub.name))
      : [];

    // Unique Sessions
    const sessionsMap = {};
    classSubLogs.forEach(log => {
      const key = `${log.date}_${log.periodId || log.periodStart}`;
      if (!sessionsMap[key]) {
        sessionsMap[key] = {
          key,
          date: log.date,
          periodId: log.periodId,
          periodStart: log.periodStart,
          periodEnd: log.periodEnd,
          presentCount: 0,
          totalCount: 0
        };
      }
      if (log.exitTime && log.status === 'present') {
        sessionsMap[key].presentCount += 1;
      }
    });
    const sessionsList = Object.values(sessionsMap).sort((a, b) => b.date.localeCompare(a.date));

    // Sessions by group
    const groupASessions = new Set();
    const groupBSessions = new Set();
    const allSessionsSet = new Set();
    classSubLogs.forEach(log => {
      const key = `${log.date}_${log.periodId || log.periodStart}`;
      allSessionsSet.add(key);

      const stu = currentClass.students.find(s => s.id === log.studentId);
      if (stu) {
        if (stu.group === 'A') {
          groupASessions.add(key);
        } else if (stu.group === 'B') {
          groupBSessions.add(key);
        }
      }
    });

    // Map student stats
    const studentStats = currentClass.students.map(student => {
      const studentLogs = classSubLogs.filter(log => log.studentId === student.id);
      const attendedCount = studentLogs.filter(log => log.exitTime && log.status === 'present').length;
      
      let totalExpected = allSessionsSet.size;
      if (currentSub && currentSub.type === 'Practical') {
        totalExpected = student.group === 'B' ? groupBSessions.size : groupASessions.size;
      }

      const pct = totalExpected > 0 ? Math.round((attendedCount / totalExpected) * 100) : 100;
      
      let status = 'safe';
      if (pct < 60) status = 'danger';
      else if (pct < 75) status = 'risk';

      return {
        ...student,
        attendedCount,
        totalExpected,
        pct,
        status,
        logs: studentLogs
      };
    });

    const totalEnrolled = currentClass.students.length;
    const avgAttendance = studentStats.length > 0 
      ? Math.round(studentStats.reduce((acc, s) => acc + s.pct, 0) / studentStats.length)
      : 0;
    const atRiskCount = studentStats.filter(s => s.pct < 75).length;
    const totalSessionsConducted = currentSub?.type === 'Practical'
      ? (groupASessions.size + groupBSessions.size)
      : allSessionsSet.size;

    // Filter students
    const filteredStudents = studentStats.filter(student => {
      const matchesSearch = student.name.toLowerCase().includes(profSearchQuery.toLowerCase()) ||
                            student.roll.toLowerCase().includes(profSearchQuery.toLowerCase());
      const matchesStatus = profFilterStatus === 'all' || student.status === profFilterStatus;
      const matchesGroup = profFilterGroup === 'all' || student.group === profFilterGroup;
      return matchesSearch && matchesStatus && matchesGroup;
    });

    const handleSubjectChange = (e) => {
      const subId = e.target.value;
      const sub = classSubjects.find(s => s.id === subId);
      if (sub) {
        setSelectedProfSubject(sub);
      }
    };

    return (
      <div className="analytics-tab-content">
        {/* Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <button className="btn-secondary" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}
            onClick={() => setSelectedProfClass(null)}>
            ← Back to Classes
          </button>
          
          <button className="btn-primary" style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'linear-gradient(135deg, var(--accent), var(--accent-dark))', boxShadow: 'none' }}
            onClick={() => setActiveQRClass(currentClass)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: '16px', height: '16px' }}>
              <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
              <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
              <rect x="7" y="7" width="10" height="10" rx="1"/>
            </svg>
            Project Session QR
          </button>
        </div>

        {/* Class Header & Subject selector */}
        <div className="analytics-overview-card" style={{ gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 900, color: 'var(--text)', margin: 0 }}>{currentClass.name}</h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: '0.2rem 0 0 0' }}>
                {currentClass.program} · Semester {currentClass.semester} · Batch {currentClass.batchStart}-{currentClass.batchEnd}
              </p>
            </div>

            {/* Subject selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: '0.5px' }}>Subject Registry</label>
              <select className="form-input" style={{ width: '220px', padding: '0.45rem', fontSize: '0.85rem', background: 'var(--bg-2)', borderRadius: '8px', border: '1px solid var(--border)', color: 'var(--text)' }}
                value={currentSub?.id || ''} onChange={handleSubjectChange}>
                {classSubjects.map(sub => (
                  <option key={sub.id} value={sub.id}>{sub.name} ({sub.type})</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Stat Grid */}
        <div className="analytics-overview-card" style={{ padding: '1.25rem' }}>
          <div className="analytics-overview-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div className={`analytics-stat-pill ${avgAttendance >= 75 ? 'green' : avgAttendance >= 60 ? 'yellow' : 'red'}`}>
              <span className="analytics-stat-num">{avgAttendance}%</span>
              <span className="analytics-stat-label">Average Attendance</span>
            </div>
            <div className="analytics-stat-pill">
              <span className="analytics-stat-num">{totalSessionsConducted}</span>
              <span className="analytics-stat-label">Sessions Conducted</span>
            </div>
            <div className="analytics-stat-pill">
              <span className="analytics-stat-num">{totalEnrolled}</span>
              <span className="analytics-stat-label">Students Enrolled</span>
            </div>
            <div className={`analytics-stat-pill ${atRiskCount > 0 ? 'red' : 'green'}`}>
              <span className="analytics-stat-num">{atRiskCount}</span>
              <span className="analytics-stat-label">Students At Risk (&lt;75%)</span>
            </div>
          </div>
        </div>

        {/* Timetable & Daily Schedule Adjustments */}
        <div className="analytics-section-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h3 className="analytics-section-title" style={{ margin: 0 }}>Timetable &amp; Schedule Adjustments</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', margin: '0.15rem 0 0 0' }}>
                View routine timetable and reschedule or cancel classes for specific dates.
              </p>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>Target Date:</span>
              <input 
                type="date" 
                className="form-input" 
                style={{ width: '150px', padding: '0.35rem 0.5rem', fontSize: '0.82rem', background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--text)' }} 
                value={adjustmentDate} 
                onChange={(e) => {
                  setAdjustmentDate(e.target.value);
                  setRescheduleDate(e.target.value);
                }} 
              />
            </div>
          </div>

          {/* Routine List for the Class */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {(currentClass.routine || []).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                No classes scheduled in routine yet.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
                {(currentClass.routine || []).map(period => {
                  const adj = classAdjustments.find(a => a.periodId === period.id && a.date === adjustmentDate);
                  
                  const isAssigned = currentPage === 'admin' || (
                    period.type === 'Theory' 
                      ? period.professors?.some(pr => pr.id === profId)
                      : (period.groupA?.professors?.some(pr => pr.id === profId) || period.groupB?.professors?.some(pr => pr.id === profId))
                  );

                  let statusText = 'Normal Schedule';
                  let statusClass = 'present';
                  if (adj) {
                    if (adj.status === 'cancelled') {
                      statusText = 'Cancelled Today';
                      statusClass = 'absent_no_exit';
                    } else if (adj.status === 'rescheduled') {
                      statusText = `Rescheduled to ${formatDate(adj.rescheduledDate)} (${adj.rescheduledStartTime}-${adj.rescheduledEndTime})`;
                      statusClass = 'pending';
                    }
                  }

                  return (
                    <div key={period.id} style={{
                      background: 'rgba(255,255,255,0.01)',
                      border: '1px solid var(--border)',
                      borderRadius: '12px',
                      padding: '1rem',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '0.75rem'
                    }}>
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--primary-light)' }}>
                            {period.type === 'Theory' ? period.subjectName : `${period.groupA?.subjectName} (Group A) / ${period.groupB?.subjectName} (Group B)`}
                          </span>
                          <span className={`session-status-badge ${statusClass}`} style={{ fontSize: '0.65rem' }}>
                            {statusText}
                          </span>
                        </div>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text)', margin: 0 }}>
                          🗓️ {period.day}s · {period.startTime} - {period.endTime} ({period.type})
                        </p>
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-dim)', margin: '0.2rem 0 0 0' }}>
                          👤 Assigned: {period.type === 'Theory' 
                            ? period.professors?.map(pr => pr.name).join(', ') 
                            : `A: ${period.groupA?.professors?.map(p=>p.name).join(', ')} | B: ${period.groupB?.professors?.map(p=>p.name).join(', ')}`}
                        </p>
                      </div>

                      {isAssigned && (
                        <div style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '0.5rem' }}>
                          {adj ? (
                            <button className="btn-secondary" style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.75rem', color: 'var(--error)' }}
                              onClick={async () => {
                                if (window.confirm('Delete adjustment and restore normal routine period?')) {
                                  await deleteAdjustment(adj.id, currentClass.id);
                                  const list = await getAdjustments(currentClass.id);
                                  setClassAdjustments(list);
                                  triggerToast('Adjustment deleted and class schedule restored!', 'success');
                                }
                              }}>
                              🗑️ Clear Adjustment
                            </button>
                          ) : (
                            <button className="btn-primary" style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.75rem', background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.3)', color: 'var(--primary-light)', boxShadow: 'none' }}
                              onClick={() => {
                                setAdjustmentModalPeriod(period);
                                setAdjustmentType('cancelled');
                              }}>
                              ⚙️ Adjust Schedule
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Search & Filters */}
        <div className="analytics-section-card">
          <div className="analytics-section-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: '260px' }}>
              <div className="input-wrap" style={{ width: '100%' }}>
                <span className="input-icon">🔍</span>
                <input type="text" className="form-input" placeholder="Search by name or roll..." style={{ padding: '0.45rem 0.45rem 0.45rem 2rem', fontSize: '0.85rem' }}
                  value={profSearchQuery} onChange={(e) => setProfSearchQuery(e.target.value)} />
              </div>
            </div>

            {/* Filter chips status */}
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {['all', 'safe', 'risk', 'danger'].map(st => (
                <button key={st} className={`student-tab-btn ${profFilterStatus === st ? 'active' : ''}`}
                  style={{ borderBottom: 'none', padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: '20px', background: profFilterStatus === st ? 'rgba(124,58,237,0.12)' : 'transparent', border: '1px solid rgba(255,255,255,0.06)' }}
                  onClick={() => setProfFilterStatus(st)}>
                  {st === 'all' ? 'All Status' : st === 'safe' ? 'Safe (≥75%)' : st === 'risk' ? 'At Risk' : 'Danger (<60%)'}
                </button>
              ))}
            </div>

            {/* Filter chips group */}
            {currentSub?.type === 'Practical' && (
              <div style={{ display: 'flex', gap: '0.4rem', borderLeft: '1px solid var(--border)', paddingLeft: '0.75rem' }}>
                {['all', 'A', 'B'].map(grp => (
                  <button key={grp} className={`student-tab-btn ${profFilterGroup === grp ? 'active' : ''}`}
                    style={{ borderBottom: 'none', padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: '20px', background: profFilterGroup === grp ? 'rgba(16,185,129,0.12)' : 'transparent', border: '1px solid rgba(255,255,255,0.06)' }}
                    onClick={() => setProfFilterGroup(grp)}>
                    {grp === 'all' ? 'All Groups' : `Group ${grp}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Students flex responsive list */}
          <div style={{ padding: '0.5rem 0' }}>
            <div className="prof-student-list-header">
              <span>Student Registry ({filteredStudents.length} matches)</span>
            </div>

            {filteredStudents.length === 0 ? (
              <div className="analytics-empty-state">
                <span style={{ fontSize: '2rem' }}>👥</span>
                <p>No students match the search or filter query.</p>
              </div>
            ) : (
              <div className="prof-student-rows-container">
                {filteredStudents.map(student => (
                  <div key={student.id} className="prof-student-row">
                    <div className="prof-student-avatar-circle">{student.name.charAt(0).toUpperCase()}</div>
                    <div className="prof-student-main">
                      <span className="prof-student-name">{student.name}</span>
                      <span className="prof-student-roll">Roll: {student.roll} · Group {student.group}</span>
                    </div>
                    
                    <div className="prof-student-pct-section">
                      <span className="prof-student-pct">{student.pct}%</span>
                      <div className="subject-progress-bar-bg" style={{ width: '100px', height: '5px' }}>
                        <div className={`subject-progress-bar-fill ${student.status}`} style={{ width: `${Math.min(student.pct, 100)}%` }} />
                      </div>
                      <span className="prof-student-ratio">{student.attendedCount}/{student.totalExpected} periods</span>
                    </div>

                    <div className="prof-student-status-col">
                      <span className={`subject-status-badge ${student.status}`}>
                        {student.status === 'safe' ? 'Safe' : student.status === 'risk' ? 'At Risk' : 'Danger'}
                      </span>
                    </div>

                    <div className="prof-student-action">
                      <button className="btn-secondary" style={{ padding: '0.35rem 0.85rem', fontSize: '0.78rem', borderRadius: '8px' }}
                        onClick={() => setSelectedProfStudent(student)}>
                        View Logs
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sessions Conducted Timeline */}
        <div className="analytics-section-card">
          <div className="analytics-section-header">
            <h3 className="analytics-section-title">Sessions Conducted ({sessionsList.length})</h3>
          </div>

          {sessionsList.length === 0 ? (
            <div className="analytics-empty-state">
              <span style={{ fontSize: '2rem' }}>📅</span>
              <p>No lectures have been logged for this subject yet.</p>
            </div>
          ) : (
            <div className="session-log-table-wrap">
              <table className="session-log-table">
                <thead>
                  <tr>
                    <th>Session Date</th>
                    <th>Period Time</th>
                    <th>Students Present</th>
                    <th>Attendance Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsList.map(session => {
                    const ratio = totalEnrolled > 0 ? Math.round((session.presentCount / totalEnrolled) * 100) : 0;
                    return (
                      <tr key={session.key} className="session-log-row">
                        <td className="session-log-date" style={{ fontWeight: 600 }}>{formatDate(session.date)}</td>
                        <td>{session.periodStart} – {session.periodEnd}</td>
                        <td>{session.presentCount} present</td>
                        <td>
                          <span className={`session-status-badge ${ratio >= 75 ? 'present' : ratio >= 50 ? 'pending' : 'absent_no_exit'}`}>
                            {ratio}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderAdjustmentModal = () => {
    if (!adjustmentModalPeriod) return null;
    const currentClass = selectedProfClass ? classes.find(c => c.id === selectedProfClass.id) : null;
    if (!currentClass) return null;

    const handleSaveAdjustment = async (e) => {
      e.preventDefault();
      
      // If rescheduling, run overlap checks
      if (adjustmentType === 'rescheduled') {
        if (!rescheduleDate || !rescheduleStartTime || !rescheduleEndTime) {
          triggerToast('Please fill in reschedule date, start time, and end time.', 'error');
          return;
        }
        
        const isOverlapping = checkOverlapForRescheduling(
          currentClass, 
          rescheduleDate, 
          rescheduleStartTime, 
          rescheduleEndTime, 
          classAdjustments,
          adjustmentModalPeriod.id
        );

        if (isOverlapping) {
          triggerToast('Cannot reschedule: The target slot overlaps with another scheduled class on that day!', 'error');
          return;
        }
      }

      const adjData = {
        classId: currentClass.id,
        periodId: adjustmentModalPeriod.id,
        date: adjustmentDate,
        status: adjustmentType,
        rescheduledDate: adjustmentType === 'rescheduled' ? rescheduleDate : null,
        rescheduledStartTime: adjustmentType === 'rescheduled' ? rescheduleStartTime : null,
        rescheduledEndTime: adjustmentType === 'rescheduled' ? rescheduleEndTime : null
      };

      await saveAdjustment(adjData);
      const list = await getAdjustments(currentClass.id);
      setClassAdjustments(list);
      setAdjustmentModalPeriod(null);
      triggerToast('Timetable adjustment saved successfully!', 'success');
    };

    return (
      <div className="login-modal-overlay active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
        <div className="login-modal-box animate-scale-up" style={{ maxWidth: '440px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1rem', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          
          <div className="modal-header-row" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
            <span className="logo-text" style={{ fontSize: '1.1rem', fontWeight: '900', color: 'var(--primary-light)' }}>
              ⚙️ Adjust Timetable Slot
            </span>
            <button 
              type="button" 
              className="modal-close" 
              onClick={() => setAdjustmentModalPeriod(null)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '1.25rem', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>

          <div>
            <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: '0.5px' }}>Routine Period Info</span>
            <h3 style={{ fontSize: '1.1rem', fontFamily: 'Outfit', fontWeight: '800', margin: '0.1rem 0 0.25rem 0', color: 'var(--text)' }}>
              {adjustmentModalPeriod.type === 'Theory' ? adjustmentModalPeriod.subjectName : 'Practical Lab (A/B)'}
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
              Original Slot: {adjustmentModalPeriod.day}s · {adjustmentModalPeriod.startTime} - {adjustmentModalPeriod.endTime}
            </p>
          </div>

          <form onSubmit={handleSaveAdjustment} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-dim)' }}>Adjustment Date</label>
              <input 
                type="date" 
                className="form-input" 
                style={{ padding: '0.45rem', fontSize: '0.85rem' }} 
                value={adjustmentDate} 
                onChange={(e) => setAdjustmentDate(e.target.value)} 
                required 
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-dim)' }}>Action type</label>
              <select 
                className="form-input" 
                style={{ padding: '0.45rem', fontSize: '0.85rem', background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--text)' }} 
                value={adjustmentType} 
                onChange={(e) => setAdjustmentType(e.target.value)}
              >
                <option value="cancelled">🚫 Cancel Class for this Date</option>
                <option value="rescheduled">🔁 Reschedule Class to a New Slot</option>
              </select>
            </div>

            {adjustmentType === 'rescheduled' && (
              <div style={{
                padding: '0.85rem',
                background: 'rgba(255,255,255,0.01)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.85rem',
                marginTop: '0.25rem'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <label style={{ fontSize: '0.72rem', fontWeight: '600', color: 'var(--text-dim)' }}>New Target Date</label>
                  <input 
                    type="date" 
                    className="form-input" 
                    style={{ padding: '0.4rem', fontSize: '0.82rem' }} 
                    value={rescheduleDate} 
                    onChange={(e) => setRescheduleDate(e.target.value)} 
                    required 
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <label style={{ fontSize: '0.72rem', fontWeight: '600', color: 'var(--text-dim)' }}>Start Time</label>
                    <input 
                      type="time" 
                      className="form-input" 
                      style={{ padding: '0.4rem', fontSize: '0.82rem' }} 
                      value={rescheduleStartTime} 
                      onChange={(e) => setRescheduleStartTime(e.target.value)} 
                      required 
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <label style={{ fontSize: '0.72rem', fontWeight: '600', color: 'var(--text-dim)' }}>End Time</label>
                    <input 
                      type="time" 
                      className="form-input" 
                      style={{ padding: '0.4rem', fontSize: '0.82rem' }} 
                      value={rescheduleEndTime} 
                      onChange={(e) => setRescheduleEndTime(e.target.value)} 
                      required 
                    />
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button 
                type="button" 
                className="btn-secondary" 
                style={{ flex: 1, padding: '0.5rem' }} 
                onClick={() => setAdjustmentModalPeriod(null)}
              >
                Cancel
              </button>
              <button 
                type="submit" 
                className="btn-primary" 
                style={{ flex: 1, padding: '0.5rem', background: 'linear-gradient(135deg, var(--accent), var(--accent-dark))', boxShadow: 'none' }}
              >
                Save Adjustment
              </button>
            </div>

          </form>
        </div>
      </div>
    );
  };

  const renderStudentLogsModal = () => {
    if (!selectedProfStudent) return null;
    
    // Find class subjects and current subject for currentClass in modal
    const currentClass = selectedProfClass ? classes.find(c => c.id === selectedProfClass.id) : null;
    if (!currentClass) return null;

    const profId = activeProfessorInfo?.professor?.id || null;

    // Scan classes to identify taught subjects
    let classSubjects = [];
    if (currentPage === 'admin') {
      const routine = currentClass.routine || [];
      const subKeys = new Set();
      routine.forEach(p => {
        if (p.type === 'Theory') {
          if (!subKeys.has(p.subjectId)) {
            subKeys.add(p.subjectId);
            classSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
          }
        } else {
          if (p.groupA && !subKeys.has(p.groupA.subjectId)) {
            subKeys.add(p.groupA.subjectId);
            classSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
          }
          if (p.groupB && !subKeys.has(p.groupB.subjectId)) {
            subKeys.add(p.groupB.subjectId);
            classSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
          }
        }
      });
    } else {
      const routine = currentClass.routine || [];
      routine.forEach(p => {
        if (p.type === 'Theory') {
          if (p.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.subjectId)) {
              classSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
            }
          }
        } else {
          if (p.groupA?.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.groupA.subjectId)) {
              classSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
            }
          }
          if (p.groupB?.professors?.some(pr => pr.id === profId)) {
            if (!classSubjects.some(s => s.id === p.groupB.subjectId)) {
              classSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
            }
          }
        }
      });
    }

    if (classSubjects.length === 0) {
      classSubjects = currentPage === 'admin' ? subjects : (activeProfessorInfo?.professor?.subjects || []);
    }

    const currentSub = selectedProfSubject || (classSubjects.length > 0 ? classSubjects[0] : null);

    return (
      <div className="modal-overlay open" onClick={(e) => e.target.classList.contains('modal-overlay') && setSelectedProfStudent(null)}>
        <div className="modal" style={{ maxWidth: '520px', padding: '1.75rem', zIndex: 1200 }}>
          <div className="modal-top-bar" style={{ marginBottom: '1rem' }}>
            <span className="modal-top-label">Attendance History Registry</span>
            <button className="modal-close" onClick={() => setSelectedProfStudent(null)}>✕</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
            <div className="student-avatar-circle" style={{ width: '48px', height: '48px', fontSize: '1.25rem', background: 'linear-gradient(135deg, var(--primary), var(--accent))' }}>
              {selectedProfStudent.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--text)', margin: 0 }}>{selectedProfStudent.name}</h3>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Roll No: {selectedProfStudent.roll} · Group {selectedProfStudent.group}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <div className="analytics-stat-pill" style={{ flex: 1, padding: '0.5rem 0.85rem' }}>
              <span className="analytics-stat-num" style={{ fontSize: '1.1rem' }}>{selectedProfStudent.pct}%</span>
              <span className="analytics-stat-label" style={{ fontSize: '0.65rem' }}>Current Attendance</span>
            </div>
            <div className="analytics-stat-pill" style={{ flex: 1, padding: '0.5rem 0.85rem' }}>
              <span className="analytics-stat-num" style={{ fontSize: '1.1rem' }}>{selectedProfStudent.attendedCount} / {selectedProfStudent.totalExpected}</span>
              <span className="analytics-stat-label" style={{ fontSize: '0.65rem' }}>Attended Ratio</span>
            </div>
          </div>

          {/* Manual Log Creation Form */}
          <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--primary-light)', marginBottom: '0.5rem' }}>
              Add Manual Attendance Record
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: '0.62rem', paddingLeft: '0.2rem' }}>Date</label>
                <input type="date" className="form-input" style={{ padding: '0.35rem', fontSize: '0.78rem' }}
                  value={manualLogDate} onChange={(e) => setManualLogDate(e.target.value)} />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: '0.62rem', paddingLeft: '0.2rem' }}>Period slot</label>
                <select className="form-input" style={{ padding: '0.35rem', fontSize: '0.78rem', background: 'var(--bg-2)', color: 'var(--text)' }}
                  value={manualLogPeriodId} onChange={(e) => setManualLogPeriodId(e.target.value)}>
                  <option value="">-- Select Period --</option>
                  {(currentClass?.routine || []).filter(p => {
                    if (currentPage === 'admin') return true;
                    if (p.type === 'Theory') {
                      return p.professors?.some(pr => pr.id === profId) && (p.subjectId === currentSub?.id || p.subjectName === currentSub?.name);
                    } else {
                      return (p.groupA?.professors?.some(pr => pr.id === profId) && p.groupA.subjectId === currentSub?.id) ||
                             (p.groupB?.professors?.some(pr => pr.id === profId) && p.groupB.subjectId === currentSub?.id);
                    }
                  }).map(p => (
                    <option key={p.id} value={p.id}>
                      {p.startTime}–{p.endTime} ({p.type})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 1fr', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: '0.62rem', paddingLeft: '0.2rem' }}>Check In</label>
                <input type="time" className="form-input" style={{ padding: '0.35rem', fontSize: '0.78rem' }}
                  value={manualLogEntryTime} onChange={(e) => setManualLogEntryTime(e.target.value)} />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: '0.62rem', paddingLeft: '0.2rem' }}>Check Out</label>
                <input type="time" className="form-input" style={{ padding: '0.35rem', fontSize: '0.78rem' }}
                  value={manualLogExitTime} disabled={manualLogStatus !== 'present'} onChange={(e) => setManualLogExitTime(e.target.value)} />
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label" style={{ fontSize: '0.62rem', paddingLeft: '0.2rem' }}>Status</label>
                <select className="form-input" style={{ padding: '0.35rem', fontSize: '0.78rem', background: 'var(--bg-2)', color: 'var(--text)' }}
                  value={manualLogStatus} onChange={(e) => setManualLogStatus(e.target.value)}>
                  <option value="present">Present</option>
                  <option value="absent_no_exit">No Exit</option>
                </select>
              </div>
            </div>

            <button type="button" className="btn-primary" style={{ padding: '0.45rem', fontSize: '0.78rem', width: '100%', marginTop: '0.25rem', boxShadow: 'none' }}
              onClick={() => handleAddManualLog(selectedProfStudent.id, currentClass.id, currentSub)}>
              Save Manual Record
            </button>
          </div>

          <span style={{ fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-dim)', display: 'block', marginBottom: '0.5rem' }}>Check-In/Out History Logs</span>

          <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
            <table className="session-log-table">
              <thead>
                <tr>
                  <th style={{ padding: '0.5rem 0.5rem' }}>Date</th>
                  <th style={{ padding: '0.5rem 0.5rem' }}>In</th>
                  <th style={{ padding: '0.5rem 0.5rem' }}>Out</th>
                  <th style={{ padding: '0.5rem 0.5rem' }}>Status</th>
                  <th style={{ padding: '0.5rem 0.5rem' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedProfStudent.logs.map(log => {
                  const isEditing = log.id === editLogId;
                  if (isEditing) {
                    return (
                      <tr key={log.id} className="session-log-row">
                        <td style={{ padding: '0.4rem' }}>{formatDate(log.entryTime)}</td>
                        <td style={{ padding: '0.4rem' }}>
                          <input type="time" className="form-input" style={{ padding: '0.2rem', fontSize: '0.78rem', width: '65px' }}
                            value={editEntryTime} onChange={(e) => setEditEntryTime(e.target.value)} />
                        </td>
                        <td style={{ padding: '0.4rem' }}>
                          <input type="time" className="form-input" style={{ padding: '0.2rem', fontSize: '0.78rem', width: '65px' }}
                            value={editExitTime} disabled={editStatus !== 'present'} onChange={(e) => setEditExitTime(e.target.value)} />
                        </td>
                        <td style={{ padding: '0.4rem' }}>
                          <select className="form-input" style={{ padding: '0.2rem', fontSize: '0.75rem', background: 'var(--bg-2)', color: 'var(--text)', width: '80px' }}
                            value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                            <option value="present">Present</option>
                            <option value="absent_no_exit">No Exit</option>
                          </select>
                        </td>
                        <td style={{ padding: '0.4rem', display: 'flex', gap: '0.25rem' }}>
                          <button type="button" className="btn-primary" style={{ padding: '0.25rem 0.45rem', fontSize: '0.65rem', boxShadow: 'none' }}
                            onClick={() => handleSaveEditLog(log, currentSub)}>✓</button>
                          <button type="button" className="btn-secondary" style={{ padding: '0.25rem 0.45rem', fontSize: '0.65rem' }}
                            onClick={handleCancelEditLog}>✕</button>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={log.id} className="session-log-row">
                      <td style={{ padding: '0.5rem 0.5rem' }}>{formatDate(log.entryTime)}</td>
                      <td style={{ padding: '0.5rem 0.5rem' }}>{formatTime(log.entryTime)}</td>
                      <td style={{ padding: '0.5rem 0.5rem' }}>{log.exitTime ? formatTime(log.exitTime) : '—'}</td>
                      <td style={{ padding: '0.5rem 0.5rem' }}>
                        <span className={`session-status-badge ${log.exitTime && log.status === 'present' ? 'present' : 'absent_no_exit'}`}>
                          {log.exitTime && log.status === 'present' ? 'Present' : 'Stale/Incomplete'}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem 0.5rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                          title="Edit log details" onClick={() => handleStartEditLog(log)}>
                          ✏️
                        </button>
                        <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                          title="Delete log details" onClick={() => handleDeleteLog(log.id, selectedProfStudent.id, currentClass.id, currentSub)}>
                          🗑️
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {selectedProfStudent.logs.length === 0 && (
                  <tr>
                    <td colSpan="5" style={{ textAlign: 'center', padding: '1.5rem 0', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                      No checked attendance slots logged.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setSelectedProfStudent(null)}>
              Close Registry
            </button>
            {currentPage === 'admin' && (
              <button 
                className="btn-primary" 
                style={{ 
                  flex: 1, 
                  background: 'linear-gradient(135deg, #ef4444, #b91c1c)', 
                  border: 'none',
                  boxShadow: 'none'
                }} 
                onClick={async () => {
                  if (window.confirm(`Are you absolutely sure you want to permanently DELETE ALL attendance logs for ${selectedProfStudent.name}? This action CANNOT be undone!`)) {
                    await handleClearAllStudentLogs(selectedProfStudent.id, currentClass.id, currentSub);
                  }
                }}
              >
                🗑️ Clear All Logs
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    if (!userId.trim() || !password.trim()) return;

    setLoading(true);

    const checkUserId = userId.trim();
    const checkPassword = password.trim();

    // Simulate network delay
    setTimeout(async () => {
      setLoading(false);
      
      const isAdmin = checkUserId === 'Adrish07' && checkPassword === '15062007Adrish!';
      
      if (isAdmin) {
        triggerToast('Welcome Admin Adrish! Redirecting...', 'success');
        setCurrentPage('admin');
        closeLoginModal();
        resetClassCreatorForm(); // Reset creator form when admin logs in
      } else {
        if (role === 'student') {
          // Dynamic student credentials check against classes database
          const authResult = await validateStudentLogin(checkUserId, checkPassword);
          if (authResult.isAuthenticated) {
            setActiveStudentInfo(authResult);
            setStudentTab('scan');
            setScanState(null);
            await refreshAttendanceLogs(authResult.student.id, authResult.classId);
            triggerToast(`Logged in successfully as ${authResult.student.name}!`, 'success');
            setCurrentPage('student_dashboard');
            closeLoginModal();
          } else {
            triggerToast('Invalid student credentials. Please check your login ID and password.', 'error');
          }
        } else {
          // Dynamic professor credentials check against professors database
          const authResult = await validateProfessorLogin(checkUserId, checkPassword);
          if (authResult.isAuthenticated) {
            setActiveProfessorInfo(authResult);
            setSelectedProfClass(null);
            setSelectedProfSubject(null);
            setProfSearchQuery('');
            setProfFilterStatus('all');
            setProfFilterGroup('all');
            setSelectedProfStudent(null);
            setProfAllAttendanceLogs(await getAllAttendanceLogs());
            triggerToast(`Logged in successfully as ${authResult.professor.name}!`, 'success');
            setCurrentPage('professor_dashboard');
            closeLoginModal();
          } else {
            triggerToast('Invalid professor credentials. Please check your login ID and password.', 'error');
          }
        }
      }
    }, 1200);
  };

  // Reset form helper
  const resetClassCreatorForm = () => {
    setEditClassId(null);
    setClassNameInput('');
    setBatchStartInput('2026');
    setBatchEndInput('2030');
    setProgramInput('B.Tech');
    setSemesterInput('1');
    setStudentRows([]);
    setExcelPasteText('');
    setRoutineList([]);
    // Reset routine constructor values
    setPeriodDay('Monday');
    setPeriodStartTime('09:00');
    setPeriodEndTime('10:00');
    setPeriodType('Theory');
    setTheoryDept('Information Technology');
    setTheorySubjectId('');
    setTheoryProf1('');
    setTheoryProf2('');
    setPracDeptA('Information Technology');
    setPracSubjectIdA('');
    setPracProf1A('');
    setPracProf2A('');
    setPracDeptB('Information Technology');
    setPracSubjectIdB('');
    setPracProf1B('');
    setPracProf2B('');
  };

  // Add individual student row
  const addStudentRow = () => {
    setStudentRows([
      ...studentRows,
      {
        id: `stu_temp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        name: '',
        roll: '',
        group: 'A',
        email: '',
        loginId: '',
        password: ''
      }
    ]);
  };

  // Delete individual student row
  const deleteStudentRow = (id) => {
    setStudentRows(studentRows.filter(row => row.id !== id));
  };

  // Update table row cells
  const updateStudentRow = (id, field, value) => {
    setStudentRows(studentRows.map(row => {
      if (row.id === id) {
        return { ...row, [field]: value };
      }
      return row;
    }));
  };

  // Clear all spreadsheet rows
  const clearStudentTable = () => {
    setStudentRows([]);
    setExcelPasteText('');
  };

  // Smart Spreadsheet Bulk Paste Handler
  const handleExcelPasteChange = (e) => {
    const text = e.target.value;
    setExcelPasteText(text);
    if (!text.trim()) return;

    // Excel and Google Sheets copy grids as Tab-Separated Values (TSV) with Newline row separators
    const rows = text.split(/\r?\n/).filter(r => r.trim());
    const parsedRows = rows.map((rowText, idx) => {
      const cols = rowText.split('\t');
      return {
        id: `stu_paste_${Date.now()}_${idx}`,
        name: (cols[0] || '').trim(),
        roll: (cols[1] || '').trim(),
        group: (cols[2] || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A',
        email: (cols[3] || '').trim(),
        loginId: (cols[4] || '').trim(),
        password: (cols[5] || '').trim()
      };
    });

    if (parsedRows.length > 0) {
      setStudentRows([...studentRows, ...parsedRows]);
      triggerToast(`Successfully parsed and appended ${parsedRows.length} students from spreadsheet!`, 'success');
      // Reset paste textarea
      setExcelPasteText('');
    }
  };

  // Publish Class to DB
  const handlePublishClass = async (e) => {
    e.preventDefault();
    if (!classNameInput.trim()) {
      triggerToast('Please provide a class name.', 'error');
      return;
    }

    if (studentRows.length === 0) {
      triggerToast('Please add at least one student detail to publish this class.', 'error');
      return;
    }

    // Basic validation of fields inside student details table
    const hasEmptyFields = studentRows.some(
      s => !s.name.trim() || !s.roll.trim() || !s.loginId.trim() || !s.password.trim()
    );

    if (hasEmptyFields) {
      triggerToast('All student details fields (except email optionally) must be filled.', 'error');
      return;
    }

    const classPayload = {
      id: editClassId,
      name: classNameInput.trim(),
      batchStart: batchStartInput,
      batchEnd: batchEndInput,
      program: programInput.trim(),
      semester: semesterInput,
      students: studentRows,
      routine: routineList
    };

    try {
      const savedData = await saveClass(classPayload);
      triggerToast(editClassId ? 'Class updated successfully!' : 'Class published successfully!', 'success');
      resetClassCreatorForm();
      loadAllData();
      if (savedData) {
        setActiveQRClass(savedData);
      }
    } catch (err) {
      triggerToast('Failed to save class. Please try again.', 'error');
      console.error(err);
    }
  };

  // Load class data into form for editing
  const handleEditClass = (cls) => {
    setEditClassId(cls.id);
    setClassNameInput(cls.name);
    setBatchStartInput(cls.batchStart.toString());
    setBatchEndInput(cls.batchEnd.toString());
    setProgramInput(cls.program);
    setSemesterInput(cls.semester.toString());
    setRoutineList(cls.routine || []);
    setStudentRows(cls.students.map(s => ({
      id: s.id,
      name: s.name,
      roll: s.roll,
      group: s.group,
      email: s.email,
      loginId: s.loginId,
      password: s.password
    })));
    triggerToast(`Loaded ${cls.name} details into form.`, 'success');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Delete class trigger
  const handleDeleteClass = async (classId, className) => {
    if (window.confirm(`Are you sure you want to permanently delete the class "${className}" and all its student login credentials?`)) {
      try {
        await deleteClass(classId);
        triggerToast(`Class "${className}" deleted.`, 'success');
        loadAllData();
        if (editClassId === classId) {
          resetClassCreatorForm();
        }
      } catch (err) {
        triggerToast('Failed to delete class.', 'error');
      }
    }
  };

  // ===================================================
  // SUBJECT MANAGEMENT HANDLERS
  // ===================================================
  const resetSubjectForm = () => {
    setEditSubjectId(null);
    setSubjectNameInput('');
    setSubjectDeptInput('Information Technology');
    setSubjectTypeInput('Theory');
  };

  const handleSaveSubject = async (e) => {
    e.preventDefault();
    if (!subjectNameInput.trim()) {
      triggerToast('Please type a subject name.', 'error');
      return;
    }

    const payload = {
      id: editSubjectId,
      name: subjectNameInput.trim(),
      department: subjectDeptInput,
      type: subjectTypeInput
    };

    try {
      await saveSubject(payload);
      triggerToast(editSubjectId ? 'Subject updated successfully!' : 'Subject added successfully!', 'success');
      resetSubjectForm();
      loadAllData();
    } catch (err) {
      triggerToast('Failed to save subject.', 'error');
    }
  };

  const handleEditSubject = (sub) => {
    setEditSubjectId(sub.id);
    setSubjectNameInput(sub.name);
    setSubjectDeptInput(sub.department);
    setSubjectTypeInput(sub.type);
    triggerToast(`Loaded subject "${sub.name}" for editing.`, 'success');
  };

  const handleDeleteSubject = async (subId, name) => {
    if (window.confirm(`Are you sure you want to delete the subject "${name}"? This will also unassign it from any professor.`)) {
      try {
        await deleteSubject(subId);
        triggerToast(`Subject "${name}" deleted.`, 'success');
        loadAllData();
        if (editSubjectId === subId) {
          resetSubjectForm();
        }
      } catch (err) {
        triggerToast('Failed to delete subject.', 'error');
      }
    }
  };

  // ===================================================
  // PROFESSOR MANAGEMENT HANDLERS
  // ===================================================
  const resetProfessorForm = () => {
    setEditProfessorId(null);
    setProfessorNameInput('');
    setProfessorLoginInput('');
    setProfessorPasswordInput('');
    setProfessorDeptInput('Information Technology');
    setProfessorSubjectsInput([]);
  };

  const handleSubjectCheckboxChange = (subId) => {
    if (professorSubjectsInput.includes(subId)) {
      setProfessorSubjectsInput(professorSubjectsInput.filter(id => id !== subId));
    } else {
      setProfessorSubjectsInput([...professorSubjectsInput, subId]);
    }
  };

  const handleSaveProfessor = async (e) => {
    e.preventDefault();
    if (!professorNameInput.trim() || !professorLoginInput.trim() || !professorPasswordInput.trim()) {
      triggerToast('Please fill in name, login ID and password.', 'error');
      return;
    }

    const payload = {
      id: editProfessorId,
      name: professorNameInput.trim(),
      loginId: professorLoginInput.trim(),
      password: professorPasswordInput.trim(),
      department: professorDeptInput,
      subjectIds: professorSubjectsInput
    };

    try {
      await saveProfessor(payload);
      triggerToast(editProfessorId ? 'Professor updated successfully!' : 'Professor added successfully!', 'success');
      resetProfessorForm();
      loadAllData();
    } catch (err) {
      triggerToast('Failed to save professor.', 'error');
    }
  };

  const handleEditProfessor = (prof) => {
    setEditProfessorId(prof.id);
    setProfessorNameInput(prof.name);
    setProfessorLoginInput(prof.loginId);
    setProfessorPasswordInput(prof.password);
    setProfessorDeptInput(prof.department);
    setProfessorSubjectsInput(prof.subjects.map(s => s.id));
    triggerToast(`Loaded professor "${prof.name}" for editing.`, 'success');
  };

  const handleDeleteProfessor = async (profId, name) => {
    if (window.confirm(`Are you sure you want to permanently delete Professor "${name}"?`)) {
      try {
        await deleteProfessor(profId);
        triggerToast(`Professor "${name}" deleted.`, 'success');
        loadAllData();
        if (editProfessorId === profId) {
          resetProfessorForm();
        }
      } catch (err) {
        triggerToast('Failed to delete professor.', 'error');
      }
    }
  };

  // ===================================================
  // CLASS ROUTINE HANDLERS
  // ===================================================
  const addRoutinePeriod = () => {
    if (!periodStartTime || !periodEndTime) {
      triggerToast('Please select start and end times.', 'error');
      return;
    }

    const slotId = `slot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    let periodItem = {
      id: slotId,
      day: periodDay,
      startTime: periodStartTime,
      endTime: periodEndTime,
      type: periodType
    };

    if (periodType === 'Theory') {
      let finalSubId = theorySubjectId;
      if (!finalSubId && filteredTheorySubjects.length > 0) {
        finalSubId = filteredTheorySubjects[0].id;
      }
      let finalProfId = theoryProf1;
      if (!finalProfId && filteredTheoryProfs.length > 0) {
        finalProfId = filteredTheoryProfs[0].id;
      }

      if (!finalSubId) {
        triggerToast('Please select a subject for this theory class.', 'error');
        return;
      }
      if (!finalProfId) {
        triggerToast('Please select a professor for this theory class.', 'error');
        return;
      }
      
      const sub = subjects.find(s => s.id === finalSubId);
      const prof1 = professors.find(p => p.id === finalProfId);
      const prof2 = professors.find(p => p.id === theoryProf2);

      if (!sub || !prof1) {
        triggerToast('Invalid subject or professor selected.', 'error');
        return;
      }

      periodItem = {
        ...periodItem,
        dept: theoryDept,
        subjectId: finalSubId,
        subjectName: sub.name,
        professors: [
          { id: prof1.id, name: prof1.name },
          ...(prof2 ? [{ id: prof2.id, name: prof2.name }] : [])
        ]
      };
    } else {
      // Practical
      let finalSubIdA = pracSubjectIdA;
      if (!finalSubIdA && filteredPracSubjectsA.length > 0) {
        finalSubIdA = filteredPracSubjectsA[0].id;
      }
      let finalProfIdA = pracProf1A;
      if (!finalProfIdA && filteredPracProfsA.length > 0) {
        finalProfIdA = filteredPracProfsA[0].id;
      }

      let finalSubIdB = pracSubjectIdB;
      if (!finalSubIdB && filteredPracSubjectsB.length > 0) {
        finalSubIdB = filteredPracSubjectsB[0].id;
      }
      let finalProfIdB = pracProf1B;
      if (!finalProfIdB && filteredPracProfsB.length > 0) {
        finalProfIdB = filteredPracProfsB[0].id;
      }

      if (!finalSubIdA || !finalProfIdA) {
        triggerToast('Please select subject and professor for Group A.', 'error');
        return;
      }
      if (!finalSubIdB || !finalProfIdB) {
        triggerToast('Please select subject and professor for Group B.', 'error');
        return;
      }

      const subA = subjects.find(s => s.id === finalSubIdA);
      const prof1A = professors.find(p => p.id === finalProfIdA);
      const prof2A = professors.find(p => p.id === pracProf2A);

      const subB = subjects.find(s => s.id === finalSubIdB);
      const prof1B = professors.find(p => p.id === finalProfIdB);
      const prof2B = professors.find(p => p.id === pracProf2B);

      if (!subA || !prof1A || !subB || !prof1B) {
        triggerToast('Invalid subject or professor selected for Group A/B.', 'error');
        return;
      }

      periodItem = {
        ...periodItem,
        groupA: {
          dept: pracDeptA,
          subjectId: finalSubIdA,
          subjectName: subA.name,
          professors: [
            { id: prof1A.id, name: prof1A.name },
            ...(prof2A ? [{ id: prof2A.id, name: prof2A.name }] : [])
          ]
        },
        groupB: {
          dept: pracDeptB,
          subjectId: finalSubIdB,
          subjectName: subB.name,
          professors: [
            { id: prof1B.id, name: prof1B.name },
            ...(prof2B ? [{ id: prof2B.id, name: prof2B.name }] : [])
          ]
        }
      };
    }

    setRoutineList([...routineList, periodItem]);
    triggerToast('Period added to routine successfully!', 'success');
  };

  const deleteRoutinePeriod = (id) => {
    setRoutineList(routineList.filter(item => item.id !== id));
    triggerToast('Period removed from routine.', 'success');
  };

  // SVGs used in code
  const capIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c3 3 9 3 12 0v-5" />
    </svg>
  );

  const userGroupIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );

  const professorAvatarIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );

  const professorIdIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );

  const eyeOpenIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

  const eyeClosedIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );

  const classesTabIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px' }}>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c3 3 9 3 12 0v-5" />
    </svg>
  );

  const subjectsTabIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px' }}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );

  const importIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px', marginRight: '6px' }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );

  const subjectBookIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px', marginRight: '6px' }}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );

  const professorTeacherIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px', marginRight: '6px' }}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );

  const emptyBoxIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '40px', height: '40px', color: 'var(--text-dim)' }}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );

  if (currentPage === 'admin') {
    const totalStudentsCount = classes.reduce((sum, c) => sum + c.students.length, 0);

    return (
      <div className="admin-dashboard-container animate-fade-in">
        {/* Admin Header Navbar */}
        <header className="admin-header">
          <div className="admin-header-inner">
            <div className="nav-logo">
              <span className="logo-icon">◈</span>
              <span className="logo-text">Attend<span className="accent">X</span> <span className="admin-role-pill">(Admin)</span></span>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
              {/* Connection Mode Indicator */}
              <div className={`db-indicator ${isFirebaseConfigured ? 'supabase' : 'local'}`}>
                <span className="indicator-dot"></span>
                <span>{isFirebaseConfigured ? 'Firebase Connected' : 'Local Storage Mode'}</span>
              </div>

              <div className="admin-user-profile">
                <div className="admin-avatar-small">AD</div>
                <div className="admin-meta-info">
                  <span className="admin-name-text">Adrish</span>
                  <span className="admin-role-pill">System Root</span>
                </div>
              </div>

              <button className="btn-secondary" style={{ padding: '0.45rem 1.25rem', fontSize: '0.85rem' }} onClick={() => setCurrentPage('landing')}>
                Log Out
              </button>
            </div>
          </div>
        </header>

        {/* Tab Switcher Toolbar */}
        <div className="admin-tabs-nav">
          <button 
            type="button" 
            className={`admin-tab-btn ${adminActiveTab === 'classes' ? 'active' : ''}`}
            onClick={() => setAdminActiveTab('classes')}
          >
            {classesTabIcon} Classes Management
          </button>
          <button 
            type="button" 
            className={`admin-tab-btn ${adminActiveTab === 'subjects_professors' ? 'active' : ''}`}
            onClick={() => setAdminActiveTab('subjects_professors')}
          >
            {subjectsTabIcon} Subjects & Professors
          </button>
        </div>

        {/* Admin Workspace Body */}
        <main className="admin-workspace" style={{ paddingTop: '1.5rem' }}>
          
          {/* TAB 1: CLASSES MANAGEMENT */}
          {adminActiveTab === 'classes' && (
            selectedProfClass ? (
              <div style={{ maxWidth: '900px', margin: '0 auto' }}>
                {renderClassDetailAnalytics()}
              </div>
            ) : (
              <>
              {/* Stats Bar */}
              <section className="admin-stats-row">
                <div className="stats-card-premium">
                  <div className="stats-icon-wrapper">◈</div>
                  <div className="stats-details">
                    <span className="stats-value">{classes.length}</span>
                    <span className="stats-label">Active Classes</span>
                  </div>
                </div>
                <div className="stats-card-premium">
                  <div className="stats-icon-wrapper emerald">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                    </svg>
                  </div>
                  <div className="stats-details">
                    <span className="stats-value">{totalStudentsCount}</span>
                    <span className="stats-label">Enrolled Students</span>
                  </div>
                </div>
              </section>

              {/* Grid Layout: Left Class Form Creator, Right Classes Directory List */}
              <div className="admin-grid-layout">
                
                {/* Column 1: Class Creator */}
                <div className="creator-form-card">
                  <div className="card-title-row">
                    <h2>{editClassId ? 'Edit Class Details' : 'Create New Class'}</h2>
                    {editClassId && (
                      <button type="button" className="btn-table-clear" style={{ fontSize: '0.78rem', padding: '0.35rem 0.75rem' }} onClick={resetClassCreatorForm}>
                        Cancel Edit
                      </button>
                    )}
                  </div>

                  <form onSubmit={handlePublishClass} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="form-row-grid">
                      <div className="form-group">
                        <label className="form-label">Class Name</label>
                        <input
                          type="text"
                          className="form-input"
                          style={{ paddingLeft: '1rem' }}
                          placeholder="e.g. CSE-A, ECE-B"
                          value={classNameInput}
                          onChange={(e) => setClassNameInput(e.target.value)}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Program Type</label>
                        <input
                          type="text"
                          className="form-input"
                          style={{ paddingLeft: '1rem' }}
                          placeholder="e.g. B.Tech, M.Tech, BCA"
                          value={programInput}
                          onChange={(e) => setProgramInput(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-row-grid">
                      <div className="form-group">
                        <label className="form-label">Batch Starting Year</label>
                        <select
                          className="form-select-custom"
                          value={batchStartInput}
                          onChange={(e) => setBatchStartInput(e.target.value)}
                        >
                          {Array.from({ length: 16 }, (_, idx) => 2020 + idx).map(year => (
                            <option key={`start_${year}`} value={year}>{year}</option>
                          ))}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Batch Ending Year</label>
                        <select
                          className="form-select-custom"
                          value={batchEndInput}
                          onChange={(e) => setBatchEndInput(e.target.value)}
                        >
                          {Array.from({ length: 16 }, (_, idx) => 2020 + idx).map(year => (
                            <option key={`end_${year}`} value={year}>{year}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Semester Select</label>
                      <select
                        className="form-select-custom"
                        value={semesterInput}
                        onChange={(e) => setSemesterInput(e.target.value)}
                      >
                        {Array.from({ length: 8 }, (_, idx) => idx + 1).map(sem => (
                          <option key={`sem_${sem}`} value={sem}>Semester {sem}</option>
                        ))}
                      </select>
                    </div>

                    {/* Smart Copy Paste Area */}
                    <div className="excel-paste-section">
                      <div className="excel-paste-title">
                        {importIcon} Bulk Spreadsheet Import
                      </div>
                      <p className="excel-paste-desc">
                        Copy rows from Excel or Google Sheets (columns in order: **Name, Roll No, Group, Email, Login ID, Password**) and paste them in the box below to import instantly.
                      </p>
                      <textarea
                        className="excel-paste-textarea"
                        placeholder="Paste Excel columns here..."
                        value={excelPasteText}
                        onChange={handleExcelPasteChange}
                      />
                    </div>

                    {/* Student Spreadsheet Grid */}
                    <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      <label className="form-label">Student Details List ({studentRows.length})</label>
                      
                      <div className="spreadsheet-table-container">
                        <table className="spreadsheet-table">
                          <thead>
                            <tr>
                              <th>Student Name</th>
                              <th>Roll Number</th>
                              <th>Group</th>
                              <th>Student Email</th>
                              <th>Login ID</th>
                              <th>Password</th>
                              <th style={{ width: '50px' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {studentRows.map((row) => (
                              <tr key={row.id}>
                                <td>
                                  <input
                                    type="text"
                                    className="spreadsheet-input"
                                    placeholder="Student name"
                                    value={row.name}
                                    onChange={(e) => updateStudentRow(row.id, 'name', e.target.value)}
                                    required
                                  />
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    className="spreadsheet-input"
                                    placeholder="Roll number"
                                    value={row.roll}
                                    onChange={(e) => updateStudentRow(row.id, 'roll', e.target.value)}
                                    required
                                  />
                                </td>
                                <td>
                                  <select
                                    className="spreadsheet-select"
                                    value={row.group}
                                    onChange={(e) => updateStudentRow(row.id, 'group', e.target.value)}
                                  >
                                    <option value="A">Group A</option>
                                    <option value="B">Group B</option>
                                  </select>
                                </td>
                                <td>
                                  <input
                                    type="email"
                                    className="spreadsheet-input"
                                    placeholder="Email (optional)"
                                    value={row.email}
                                    onChange={(e) => updateStudentRow(row.id, 'email', e.target.value)}
                                  />
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    className="spreadsheet-input"
                                    placeholder="Login ID"
                                    value={row.loginId}
                                    onChange={(e) => updateStudentRow(row.id, 'loginId', e.target.value)}
                                    required
                                  />
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    className="spreadsheet-input"
                                    placeholder="Password"
                                    value={row.password}
                                    onChange={(e) => updateStudentRow(row.id, 'password', e.target.value)}
                                    required
                                  />
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <button
                                    type="button"
                                    className="btn-row-action"
                                    onClick={() => deleteStudentRow(row.id)}
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            ))}
                            {studentRows.length === 0 && (
                              <tr>
                                <td colSpan="7" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-dim)' }}>
                                  No students added. Use spreadsheet import or add row manually below.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Spreadsheet manual buttons */}
                      <div className="table-controls-row">
                        <button type="button" className="btn-table-add" onClick={addStudentRow}>
                          + Add Single Student Row
                        </button>
                        {studentRows.length > 0 && (
                          <button type="button" className="btn-table-clear" onClick={clearStudentTable}>
                            Clear Table
                          </button>
                        )}
                      </div>
                    </div>

                    {/* ===== CLASS TIMETABLE ROUTINE BUILDER ===== */}
                    <div className="routine-builder-section">
                      <div className="card-title-row" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '0.5rem' }}>
                        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.2rem', fontFamily: 'Outfit' }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '20px', height: '20px', color: 'var(--accent-light)' }}>
                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                            <line x1="16" y1="2" x2="16" y2="6" />
                            <line x1="8" y1="2" x2="8" y2="6" />
                            <line x1="3" y1="10" x2="21" y2="10" />
                          </svg>
                          Class Routine & Timetable Builder
                        </h2>
                      </div>
                      <p className="excel-paste-desc" style={{ marginBottom: '0.5rem' }}>
                        Configure the daily periods/timetable slots for this class. Add Theory periods or dual-group parallel Practicals.
                      </p>

                      <div className="routine-form-row">
                        <div className="form-group">
                          <label className="form-label">Day of Week</label>
                          <select 
                            className="form-select-custom" 
                            value={periodDay} 
                            onChange={(e) => setPeriodDay(e.target.value)}
                          >
                            <option value="Monday">Monday</option>
                            <option value="Tuesday">Tuesday</option>
                            <option value="Wednesday">Wednesday</option>
                            <option value="Thursday">Thursday</option>
                            <option value="Friday">Friday</option>
                            <option value="Saturday">Saturday</option>
                          </select>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Start Time (IST)</label>
                          <input 
                            type="time" 
                            className="form-input" 
                            style={{ padding: '0.45rem 0.75rem', height: '40px' }}
                            value={periodStartTime} 
                            onChange={(e) => setPeriodStartTime(e.target.value)}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">End Time (IST)</label>
                          <input 
                            type="time" 
                            className="form-input" 
                            style={{ padding: '0.45rem 0.75rem', height: '40px' }}
                            value={periodEndTime} 
                            onChange={(e) => setPeriodEndTime(e.target.value)}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Class Type</label>
                          <select 
                            className="form-select-custom" 
                            value={periodType} 
                            onChange={(e) => setPeriodType(e.target.value)}
                          >
                            <option value="Theory">Theory Period</option>
                            <option value="Practical">Practical Lab Period</option>
                          </select>
                        </div>
                      </div>

                      {/* THEORY CONFIG PANEL */}
                      {periodType === 'Theory' && (
                        <div style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <span style={{ fontSize: '0.85rem', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--primary-light)' }}>
                            Theory Period Configuration
                          </span>
                          
                          <div className="routine-form-row">
                            <div className="form-group">
                              <label className="form-label">Subject Department</label>
                              <select 
                                className="form-select-custom" 
                                value={theoryDept}
                                onChange={(e) => handleTheoryDeptChange(e.target.value)}
                              >
                                <option value="Information Technology">Information Technology</option>
                                <option value="Computer Science">Computer Science</option>
                                <option value="Ceramic Technology">Ceramic Technology</option>
                                <option value="Basic Sciences and Humanities">Basic Sciences and Humanities</option>
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Select Theory Subject</label>
                              <select 
                                className="form-select-custom" 
                                value={theorySubjectId}
                                onChange={(e) => handleTheorySubjectChange(e.target.value)}
                              >
                                {filteredTheorySubjects.map(s => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                                {filteredTheorySubjects.length === 0 && (
                                  <option value="">No Theory Subjects Found</option>
                                )}
                              </select>
                            </div>
                          </div>

                          <div className="routine-form-row">
                            <div className="form-group">
                              <label className="form-label">Primary Professor</label>
                              <select 
                                className="form-select-custom" 
                                value={theoryProf1}
                                onChange={(e) => setTheoryProf1(e.target.value)}
                              >
                                {filteredTheoryProfs.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                                {filteredTheoryProfs.length === 0 && (
                                  <option value="">No matching teacher in list</option>
                                )}
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Co-Teacher / Secondary Professor (Optional)</label>
                              <select 
                                className="form-select-custom" 
                                value={theoryProf2}
                                onChange={(e) => setTheoryProf2(e.target.value)}
                              >
                                <option value="">-- None (Single Teacher) --</option>
                                {filteredTheoryProfs.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* PRACTICAL CONFIG PANEL */}
                      {periodType === 'Practical' && (
                        <div className="practical-group-layout-grid">
                          {/* Group A Column */}
                          <div className="group-form-card">
                            <div className="group-card-header-label">Group A Practical Details</div>
                            
                            <div className="form-group">
                              <label className="form-label">Department</label>
                              <select 
                                className="form-select-custom" 
                                value={pracDeptA}
                                onChange={(e) => handlePracDeptAChange(e.target.value)}
                              >
                                <option value="Information Technology">Information Technology</option>
                                <option value="Computer Science">Computer Science</option>
                                <option value="Ceramic Technology">Ceramic Technology</option>
                                <option value="Basic Sciences and Humanities">Basic Sciences and Humanities</option>
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Practical Subject</label>
                              <select 
                                className="form-select-custom" 
                                value={pracSubjectIdA}
                                onChange={(e) => handlePracSubjectAChange(e.target.value)}
                              >
                                {filteredPracSubjectsA.map(s => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                                {filteredPracSubjectsA.length === 0 && (
                                  <option value="">No Practical Labs Found</option>
                                )}
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Primary Lab Professor</label>
                              <select 
                                className="form-select-custom" 
                                value={pracProf1A}
                                onChange={(e) => setPracProf1A(e.target.value)}
                              >
                                {filteredPracProfsA.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                                {filteredPracProfsA.length === 0 && (
                                  <option value="">No matching teacher in list</option>
                                )}
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Co-Teacher (Optional)</label>
                              <select 
                                className="form-select-custom" 
                                value={pracProf2A}
                                onChange={(e) => setPracProf2A(e.target.value)}
                              >
                                <option value="">-- None --</option>
                                {filteredPracProfsA.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          {/* Group B Column */}
                          <div className="group-form-card group-b">
                            <div className="group-card-header-label">Group B Practical Details</div>
                            
                            <div className="form-group">
                              <label className="form-label">Department</label>
                              <select 
                                className="form-select-custom" 
                                value={pracDeptB}
                                onChange={(e) => handlePracDeptBChange(e.target.value)}
                              >
                                <option value="Information Technology">Information Technology</option>
                                <option value="Computer Science">Computer Science</option>
                                <option value="Ceramic Technology">Ceramic Technology</option>
                                <option value="Basic Sciences and Humanities">Basic Sciences and Humanities</option>
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Practical Subject</label>
                              <select 
                                className="form-select-custom" 
                                value={pracSubjectIdB}
                                onChange={(e) => handlePracSubjectBChange(e.target.value)}
                              >
                                {filteredPracSubjectsB.map(s => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                                {filteredPracSubjectsB.length === 0 && (
                                  <option value="">No Practical Labs Found</option>
                                )}
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Primary Lab Professor</label>
                              <select 
                                className="form-select-custom" 
                                value={pracProf1B}
                                onChange={(e) => setPracProf1B(e.target.value)}
                              >
                                {filteredPracProfsB.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                                {filteredPracProfsB.length === 0 && (
                                  <option value="">No matching teacher in list</option>
                                )}
                              </select>
                            </div>

                            <div className="form-group">
                              <label className="form-label">Co-Teacher (Optional)</label>
                              <select 
                                className="form-select-custom" 
                                value={pracProf2B}
                                onChange={(e) => setPracProf2B(e.target.value)}
                              >
                                <option value="">-- None --</option>
                                {filteredPracProfsB.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      )}

                      <button 
                        type="button" 
                        className="btn-table-add" 
                        style={{ alignSelf: 'flex-start', marginTop: '0.5rem', background: 'var(--accent-light)', color: '#0f172a', fontWeight: '800' }}
                        onClick={addRoutinePeriod}
                      >
                        + Add Period to Routine
                      </button>
                    </div>

                    {/* ===== ROUTINE TIME TABLE VIEW GRAPHIC ===== */}
                    <div className="timetable-section">
                      <div className="card-title-row">
                        <h3 style={{ fontSize: '1.05rem', fontFamily: 'Outfit', fontWeight: '800', color: 'var(--text-muted)' }}>
                          Timetable Preview Grid
                        </h3>
                      </div>
                      
                      <div className="timetable-calendar-container">
                        {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(day => {
                          const dayPeriods = routineList
                            .filter(p => p.day === day)
                            .sort((a, b) => a.startTime.localeCompare(b.startTime));

                          return (
                            <div key={day} className="timetable-day-row">
                              <div className="timetable-day-heading">
                                <span style={{ color: 'var(--accent-light)' }}>◈</span> {day}
                              </div>

                              <div className="timetable-periods-track">
                                {dayPeriods.map(p => (
                                  <div key={p.id} className="timetable-period-card">
                                    <button 
                                      type="button" 
                                      className="timetable-delete-btn"
                                      onClick={() => deleteRoutinePeriod(p.id)}
                                      title="Remove period"
                                    >
                                      ✕
                                    </button>

                                    <div className="timetable-card-header">
                                      <span className="timetable-card-time">{p.startTime} – {p.endTime}</span>
                                      <span className={`sub-badge ${p.type.toLowerCase()}`}>
                                        {p.type}
                                      </span>
                                    </div>

                                    {p.type === 'Theory' ? (
                                      <div className="timetable-card-type-bar" style={{ borderColor: 'var(--primary-light)' }}>
                                        <div className="timetable-card-subject-title">{p.subjectName}</div>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
                                          <span className="dept-tag it" style={{ fontSize: '0.62rem', padding: '0.1rem 0.35rem' }}>{p.dept.split(' ')[0]}</span>
                                        </div>
                                        <div className="timetable-card-professors" style={{ marginTop: '0.35rem' }}>
                                          <span style={{ opacity: 0.6 }}>👨‍🏫</span>
                                          <span>{p.professors.map(prof => prof.name).join(' + ')}</span>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="timetable-dual-group-grid">
                                        {/* Group A half */}
                                        <div className="timetable-group-half">
                                          <div className="timetable-group-label-pill">Grp A</div>
                                          <div className="timetable-card-subject-title" style={{ fontSize: '0.85rem' }}>{p.groupA.subjectName}</div>
                                          <div className="timetable-card-professors" style={{ fontSize: '0.72rem' }}>
                                            <span>{p.groupA.professors.map(prof => prof.name).join(' + ')}</span>
                                          </div>
                                        </div>
                                        {/* Group B half */}
                                        <div className="timetable-group-half group-b">
                                          <div className="timetable-group-label-pill">Grp B</div>
                                          <div className="timetable-card-subject-title" style={{ fontSize: '0.85rem' }}>{p.groupB.subjectName}</div>
                                          <div className="timetable-card-professors" style={{ fontSize: '0.72rem' }}>
                                            <span>{p.groupB.professors.map(prof => prof.name).join(' + ')}</span>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ))}

                                {dayPeriods.length === 0 && (
                                  <div style={{ color: 'var(--text-dim)', fontSize: '0.82rem', padding: '0.5rem 0', fontStyle: 'italic' }}>
                                    No periods scheduled for {day}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                {/* Create/Publish Button */}
                <div className="creator-actions">
                      <button type="submit" className="btn-primary" style={{ padding: '0.75rem 2.5rem' }}>
                        {editClassId ? 'Save Class Changes' : 'Create & Publish Class'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Column 2: Directory */}
                <div className="classes-directory-card">
                  <div className="card-title-row">
                    <h2>Published Directory</h2>
                  </div>

                  <div className="classes-list-grid">
                    {classes.map((cls) => (
                      <div key={cls.id} className="published-class-item">
                        <div className="class-item-details">
                          <span className="class-item-title">{cls.name}</span>
                          <div className="class-item-meta">
                            <span>{cls.program}</span>
                            <span className="meta-divider"></span>
                            <span>Semester {cls.semester}</span>
                            <span className="meta-divider"></span>
                            <span>Batch {cls.batchStart}–{cls.batchEnd}</span>
                            <span className="meta-divider"></span>
                            <span className="accent" style={{ fontWeight: '600' }}>{cls.students.length} Students</span>
                          </div>
                        </div>
                        <div className="class-item-actions">
                          <button type="button" className="btn-action-qr" onClick={() => setActiveQRClass(cls)} style={{ background: 'rgba(139, 92, 246, 0.1)', color: 'var(--primary-light)', border: '1px solid rgba(139, 92, 246, 0.2)', padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: '4px', cursor: 'pointer', transition: 'var(--transition)' }}>
                            QR Code
                          </button>
                          <button type="button" className="btn-action-edit" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--accent)', border: '1px solid rgba(16, 185, 129, 0.2)' }} onClick={() => { setSelectedProfClass(cls); setSelectedProfSubject(null); }}>
                            Analytics
                          </button>
                          <button type="button" className="btn-action-edit" onClick={() => handleEditClass(cls)}>
                            Edit
                          </button>
                          <button type="button" className="btn-action-delete" onClick={() => handleDeleteClass(cls.id, cls.name)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}

                    {classes.length === 0 && (
                      <div className="no-classes-empty">
                        {emptyBoxIcon}
                        <p style={{ marginTop: '0.75rem' }}>No published classes listed. Create one using the constructor form on the left.</p>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </>
          )
        )}

          {/* TAB 2: SUBJECTS & PROFESSORS MANAGEMENT */}
          {adminActiveTab === 'subjects_professors' && (
            <div className="admin-grid-layout">
              
              {/* Left Column: Creator Forms for Subject & Professor */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', minWidth: 0, width: '100%' }}>
                
                {/* Section A: Subject Creator */}
                <div className="creator-form-card">
                  <div className="card-title-row">
                    <h2 style={{ display: 'flex', alignItems: 'center' }}>
                      {subjectBookIcon} {editSubjectId ? 'Edit Subject' : 'Add New Subject'}
                    </h2>
                    {editSubjectId && (
                      <button type="button" className="btn-table-clear" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={resetSubjectForm}>
                        Cancel Edit
                      </button>
                    )}
                  </div>

                  <form onSubmit={handleSaveSubject} style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
                    <div className="form-group">
                      <label className="form-label">Subject Name</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder="e.g. Computer Networks, Analog Electronics" 
                        style={{ paddingLeft: '1rem' }}
                        value={subjectNameInput}
                        onChange={(e) => setSubjectNameInput(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-row-grid">
                      <div className="form-group">
                        <label className="form-label">Department</label>
                        <select 
                          className="form-select-custom"
                          value={subjectDeptInput}
                          onChange={(e) => setSubjectDeptInput(e.target.value)}
                        >
                          <option value="Information Technology">Information Technology</option>
                          <option value="Computer Science">Computer Science</option>
                          <option value="Ceramic Technology">Ceramic Technology</option>
                          <option value="Basic Sciences and Humanities">Basic Sciences and Humanities</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Subject Type</label>
                        <select 
                          className="form-select-custom"
                          value={subjectTypeInput}
                          onChange={(e) => setSubjectTypeInput(e.target.value)}
                        >
                          <option value="Theory">Theory</option>
                          <option value="Practical">Practical</option>
                        </select>
                      </div>
                    </div>

                    <div className="creator-actions" style={{ marginTop: '0.5rem', paddingTop: '1rem' }}>
                      <button type="submit" className="btn-primary" style={{ padding: '0.65rem 2rem' }}>
                        {editSubjectId ? 'Save Changes' : 'Save Subject'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Section B: Professor Creator */}
                <div className="creator-form-card">
                  <div className="card-title-row">
                    <h2 style={{ display: 'flex', alignItems: 'center' }}>
                      {professorTeacherIcon} {editProfessorId ? 'Edit Faculty Record' : 'Add New Professor'}
                    </h2>
                    {editProfessorId && (
                      <button type="button" className="btn-table-clear" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={resetProfessorForm}>
                        Cancel Edit
                      </button>
                    )}
                  </div>

                  <form onSubmit={handleSaveProfessor} style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
                    <div className="form-group">
                      <label className="form-label">Professor Name</label>
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder="e.g. Dr. A.K. Sen" 
                        style={{ paddingLeft: '1rem' }}
                        value={professorNameInput}
                        onChange={(e) => setProfessorNameInput(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-row-grid">
                      <div className="form-group">
                        <label className="form-label">Login ID</label>
                        <input 
                          type="text" 
                          className="form-input" 
                          placeholder="Username" 
                          style={{ paddingLeft: '1rem' }}
                          value={professorLoginInput}
                          onChange={(e) => setProfessorLoginInput(e.target.value)}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Password</label>
                        <input 
                          type="text" 
                          className="form-input" 
                          placeholder="Password" 
                          style={{ paddingLeft: '1rem' }}
                          value={professorPasswordInput}
                          onChange={(e) => setProfessorPasswordInput(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Primary Department</label>
                      <select 
                        className="form-select-custom"
                        value={professorDeptInput}
                        onChange={(e) => {
                          setProfessorDeptInput(e.target.value);
                          // Clear selected subjects since department changed
                          setProfessorSubjectsInput([]);
                        }}
                      >
                        <option value="Information Technology">Information Technology</option>
                        <option value="Computer Science">Computer Science</option>
                        <option value="Ceramic Technology">Ceramic Technology</option>
                        <option value="Basic Sciences and Humanities">Basic Sciences and Humanities</option>
                      </select>
                    </div>

                    {/* Dynamic Subjects Checklist for Professor */}
                    <div className="form-group">
                      <label className="form-label" style={{ color: 'var(--accent-light)' }}>
                        Assign Subjects under {professorDeptInput}
                      </label>
                      <p className="excel-paste-desc" style={{ marginBottom: '0.5rem' }}>
                        Check the subjects taught by this professor. Only subjects added under this department are shown.
                      </p>
                      
                      <div className="checkbox-grid">
                        {subjects
                          .filter(s => s.department === professorDeptInput)
                          .map(sub => {
                            const isChecked = professorSubjectsInput.includes(sub.id);
                            return (
                              <label key={sub.id} className={`checkbox-item ${isChecked ? 'checked' : ''}`}>
                                <input 
                                  type="checkbox" 
                                  checked={isChecked}
                                  onChange={() => handleSubjectCheckboxChange(sub.id)}
                                />
                                <span style={{ flex: 1 }}>{sub.name}</span>
                                <span className={`sub-badge ${sub.type.toLowerCase()}`}>
                                  {sub.type}
                                </span>
                              </label>
                            );
                          })}
                        
                        {subjects.filter(s => s.department === professorDeptInput).length === 0 && (
                          <div className="checkbox-empty-msg">
                            No subjects listed under "{professorDeptInput}". Add one above first.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="creator-actions" style={{ marginTop: '0.5rem', paddingTop: '1rem' }}>
                      <button type="submit" className="btn-primary" style={{ padding: '0.65rem 2rem' }}>
                        {editProfessorId ? 'Save Changes' : 'Save Professor'}
                      </button>
                    </div>
                  </form>
                </div>

              </div>

              {/* Right Column: Directories for Subjects & Professors */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', minWidth: 0, width: '100%' }}>
                
                {/* Subject Directory */}
                <div className="classes-directory-card">
                  <div className="card-title-row">
                    <h2>Published Subjects ({subjects.length})</h2>
                  </div>

                  <div className="classes-list-grid" style={{ maxHeight: '350px', overflowY: 'auto' }}>
                    {subjects.map(sub => {
                      let deptClass = 'cs';
                      if (sub.department === 'Information Technology') deptClass = 'it';
                      if (sub.department === 'Ceramic Technology') deptClass = 'cer';
                      if (sub.department === 'Basic Sciences and Humanities') deptClass = 'bsh';

                      return (
                        <div key={sub.id} className="published-class-item" style={{ padding: '0.85rem 1.25rem' }}>
                          <div className="class-item-details" style={{ gap: '0.2rem' }}>
                            <span className="class-item-title" style={{ fontSize: '0.98rem' }}>{sub.name}</span>
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                              <span className={`dept-tag ${deptClass}`}>{sub.department.split(' ')[0]}</span>
                              <span className={`sub-badge ${sub.type.toLowerCase()}`}>{sub.type}</span>
                            </div>
                          </div>
                          <div className="class-item-actions">
                            <button type="button" className="btn-action-edit" style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem' }} onClick={() => handleEditSubject(sub)}>
                              Edit
                            </button>
                            <button type="button" className="btn-action-delete" style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem' }} onClick={() => handleDeleteSubject(sub.id, sub.name)}>
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {subjects.length === 0 && (
                      <div className="no-classes-empty" style={{ padding: '2rem 1rem' }}>
                        {emptyBoxIcon}
                        <p style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>No subjects added yet. Populate the subject builder card.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Professor Directory */}
                <div className="classes-directory-card">
                  <div className="card-title-row">
                    <h2>Faculty Directory ({professors.length})</h2>
                  </div>

                  <div className="classes-list-grid" style={{ maxHeight: '450px', overflowY: 'auto' }}>
                    {professors.map(prof => {
                      let deptClass = 'cs';
                      if (prof.department === 'Information Technology') deptClass = 'it';
                      if (prof.department === 'Ceramic Technology') deptClass = 'cer';
                      if (prof.department === 'Basic Sciences and Humanities') deptClass = 'bsh';

                      return (
                        <div key={prof.id} className="published-class-item" style={{ padding: '1rem 1.25rem', flexDirection: 'column', alignItems: 'stretch', gap: '0.85rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                            <div className="class-item-details">
                              <span className="class-item-title" style={{ fontSize: '1.05rem' }}>{prof.name}</span>
                              <span className={`dept-tag ${deptClass}`} style={{ marginTop: '0.2rem', alignSelf: 'flex-start' }}>{prof.department}</span>
                              <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.35rem' }}>
                                <span>User: <strong style={{ color: 'var(--text)' }}>{prof.loginId}</strong></span>
                                <span>Pass: <strong style={{ color: 'var(--text)' }}>{prof.password}</strong></span>
                              </div>
                            </div>
                            <div className="class-item-actions">
                              <button type="button" className="btn-action-edit" style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem' }} onClick={() => handleEditProfessor(prof)}>
                                Edit
                              </button>
                              <button type="button" className="btn-action-delete" style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem' }} onClick={() => handleDeleteProfessor(prof.id, prof.name)}>
                                Delete
                              </button>
                            </div>
                          </div>

                          {/* Associated Subjects Row */}
                          <div>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: '600' }}>Teaching subjects:</span>
                            <div className="assigned-subjects-row">
                              {prof.subjects && prof.subjects.map(sub => (
                                <span key={sub.id} className="assigned-sub-pill">
                                  {sub.name} ({sub.type[0]})
                                </span>
                              ))}
                              {(!prof.subjects || prof.subjects.length === 0) && (
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>No subjects assigned</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {professors.length === 0 && (
                      <div className="no-classes-empty" style={{ padding: '2rem 1rem' }}>
                        {emptyBoxIcon}
                        <p style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>No professors onboarded yet. Fill details on the left.</p>
                      </div>
                    )}
                  </div>
                </div>

              </div>

            </div>
          )}

        {/* ===== ATTENDANCE QR CODE MODAL ===== */}
        {activeQRClass && (
          <div className="login-modal-overlay active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
            <div className="login-modal-box animate-scale-up" style={{ maxWidth: '440px', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '1rem' }}>
              
              <div className="modal-header-row" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="logo-text" style={{ fontSize: '1.1rem', fontWeight: '900', color: 'var(--primary-light)' }}>
                  ◈ AttendX Poster Panel
                </span>
                <button 
                  type="button" 
                  className="modal-close" 
                  onClick={() => setActiveQRClass(null)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '1.25rem', cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>

              <div style={{ marginTop: '0.5rem' }}>
                <h2 style={{ fontSize: '1.4rem', fontFamily: 'Outfit', fontWeight: '900', margin: '0 0 0.25rem 0', color: 'var(--text)' }}>
                  {activeQRClass.name}
                </h2>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
                  {activeQRClass.program} • Semester {activeQRClass.semester} • Batch {activeQRClass.batchStart}-{activeQRClass.batchEnd}
                </p>
              </div>

              {/* Stylish QR Code Canvas Wrapper */}
              <div style={{ background: '#ffffff', padding: '1.25rem', borderRadius: '16px', boxShadow: '0 10px 30px rgba(139, 92, 246, 0.15)', margin: '1rem 0' }}>
                <canvas ref={qrCanvasRef} style={{ width: '240px', height: '240px', display: 'block' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                <button 
                  type="button" 
                  className="btn-primary" 
                  style={{ width: '100%', padding: '0.65rem' }} 
                  onClick={() => {
                    if (qrCanvasRef.current) {
                      const qrDataUrl = qrCanvasRef.current.toDataURL('image/png');
                      const printWindow = window.open('', '_blank');
                      printWindow.document.write(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                          <title>Attendance QR Poster - ${activeQRClass.name}</title>
                          <style>
                            @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&family=Inter:wght@400;600&display=swap');
                            body {
                              margin: 0;
                              padding: 0;
                              display: flex;
                              flex-direction: column;
                              align-items: center;
                              justify-content: space-between;
                              height: 297mm; /* A4 height */
                              width: 210mm;  /* A4 width */
                              box-sizing: border-box;
                              padding: 25mm;
                              font-family: 'Outfit', sans-serif;
                              background: #ffffff;
                              color: #0f172a;
                              text-align: center;
                            }
                            .header {
                              display: flex;
                              flex-direction: column;
                              align-items: center;
                              gap: 10px;
                              margin-top: 10mm;
                            }
                            .brand {
                              font-size: 24px;
                              font-weight: 900;
                              color: #8b5cf6;
                              display: flex;
                              align-items: center;
                              gap: 8px;
                              letter-spacing: -0.5px;
                            }
                            .title {
                              font-size: 44px;
                              font-weight: 900;
                              margin: 20px 0 5px 0;
                              color: #0f172a;
                              letter-spacing: -1.5px;
                              line-height: 1.1;
                              text-transform: uppercase;
                            }
                            .subtitle {
                              font-size: 18px;
                              color: #64748b;
                              font-family: 'Inter', sans-serif;
                              font-weight: 500;
                              max-width: 500px;
                            }
                            .class-card {
                              border: 2px solid #e2e8f0;
                              border-radius: 16px;
                              padding: 15px 30px;
                              margin-top: 25px;
                              background: #f8fafc;
                              display: inline-block;
                            }
                            .class-name {
                              font-size: 32px;
                              font-weight: 900;
                              color: #8b5cf6;
                              margin-bottom: 5px;
                            }
                            .class-meta {
                              font-size: 15px;
                              color: #64748b;
                              font-family: 'Inter', sans-serif;
                              font-weight: 600;
                            }
                            .qr-container {
                              margin: auto 0;
                              display: flex;
                              flex-direction: column;
                              align-items: center;
                              position: relative;
                            }
                            .qr-frame {
                              padding: 24px;
                              border: 6px solid #8b5cf6;
                              border-radius: 28px;
                              background: #ffffff;
                              box-shadow: 0 25px 50px rgba(139, 92, 246, 0.12);
                            }
                            .qr-img {
                              width: 360px;
                              height: 360px;
                              display: block;
                            }
                            .footer {
                              display: flex;
                              flex-direction: column;
                              align-items: center;
                              gap: 15px;
                              font-family: 'Inter', sans-serif;
                              margin-bottom: 10mm;
                            }
                            .footer-instruction {
                              font-size: 20px;
                              font-weight: 800;
                              color: #1e293b;
                              max-width: 520px;
                              line-height: 1.4;
                            }
                            .footer-note {
                              font-size: 12px;
                              color: #94a3b8;
                              font-weight: 500;
                            }
                            @media print {
                              body {
                                padding: 20mm;
                              }
                            }
                          </style>
                        </head>
                        <body>
                          <div class="header">
                            <div class="brand">◈ ATTENDX SYSTEM</div>
                            <div class="title">SCAN FOR ATTENDANCE</div>
                            <div class="subtitle">Scan this custom-styled QR code below using your student mobile portal to mark class attendance</div>
                            <div class="class-card">
                              <div class="class-name">${activeQRClass.name}</div>
                              <div class="class-meta">${activeQRClass.program} &bull; Semester ${activeQRClass.semester} &bull; Batch ${activeQRClass.batchStart}-${activeQRClass.batchEnd}</div>
                            </div>
                          </div>

                          <div class="qr-container">
                            <div class="qr-frame">
                              <img class="qr-img" src="${qrDataUrl}" />
                            </div>
                          </div>

                          <div class="footer">
                            <div class="footer-instruction">
                              Scan while entering class and again scan once class is ended.
                            </div>
                            <div class="footer-note">
                              Generated by AttendX System &bull; Live Realtime Attendance Tracker
                            </div>
                          </div>
                          <script>
                            window.onload = function() {
                              window.print();
                              setTimeout(function() { window.close(); }, 500);
                            };
                          <\/script>
                        </body>
                        </html>
                      `);
                      printWindow.document.close();
                    }
                  }}
                >
                  Download / Print A4 Poster
                </button>
                
                <button 
                  type="button" 
                  className="btn-secondary" 
                  style={{ width: '100%', padding: '0.65rem' }} 
                  onClick={() => setActiveQRClass(null)}
                >
                  Back to Panel
                </button>
              </div>

            </div>
          </div>
        )}

        {renderStudentLogsModal()}
        {renderAdjustmentModal()}

        </main>
        
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              <span className="toast-icon">{toast.type === 'success' ? '✅' : '❌'}</span>
              <span>{toast.message}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Conditional rendering for Student Dashboard Portal
  if (currentPage === 'student_dashboard' && activeStudentInfo) {
    const studentData = activeStudentInfo.student;
    const today = getTodayDate();
    const todayDayName = getTodayDayName();

    // ---- Analytics computation ----
    // Build per-subject stats from attendanceLogs
    const completedLogs = attendanceLogs.filter(r => r.exitTime && r.status === 'present');
    const subjectMap = {};

    // First, count total expected periods per subject from the routine (up to today)
    const routine = activeStudentInfo.routine || [];
    const nowDate = new Date();
    // Days of week index
    const dayIndex = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

    routine.forEach(period => {
      const subInfo = getPeriodSubjectInfo(period, studentData.group);
      if (!subInfo) return;
      const key = subInfo.subjectId || subInfo.subjectName;
      if (!subjectMap[key]) {
        subjectMap[key] = {
          subjectName: subInfo.subjectName,
          subjectId: subInfo.subjectId,
          type: subInfo.type,
          totalExpected: 0,
          attended: 0
        };
      }
      // Count how many times this period has occurred up to today
      // (rough: count weeks since a fixed date — we just count attended vs completed for now)
    });

    // Count attended from logs
    completedLogs.forEach(log => {
      const key = log.subjectId || log.subjectName;
      if (!subjectMap[key]) {
        subjectMap[key] = {
          subjectName: log.subjectName,
          subjectId: log.subjectId,
          type: 'Theory',
          totalExpected: 0,
          attended: 0
        };
      }
      subjectMap[key].attended += 1;
      subjectMap[key].totalExpected = Math.max(subjectMap[key].totalExpected, subjectMap[key].attended);
    });

    const subjectStats = Object.values(subjectMap);
    const totalAttended = completedLogs.length;
    const totalSessions = Math.max(totalAttended, 1);
    const totalPossible = subjectStats.reduce((s, x) => s + x.totalExpected, 0) || totalAttended || 1;
    const overallPct = totalPossible > 0 ? Math.round((totalAttended / totalPossible) * 100) : 0;
    const ringCircumference = 2 * Math.PI * 45;
    const ringFill = (overallPct / 100) * ringCircumference;

    // Today's sessions
    const todayLogs = attendanceLogs.filter(r => r.date === today);

    return (
      <div className="student-portal-container animate-fade-in">
        {/* Ambient background */}
        <div className="hero-bg" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}>
          <div className="orb orb-2" style={{ opacity: 0.3 }}></div>
          <div className="grid-overlay"></div>
        </div>

        {/* Student Header */}
        <header className="student-header">
          <div className="student-header-inner">
            <div className="nav-logo">
              <span className="logo-icon">◈</span>
              <span className="logo-text">Attend<span className="accent">X</span></span>
            </div>
            <div className="student-header-profile">
              <div className="student-avatar-chip">
                <div className="student-avatar-circle">{studentData.name.charAt(0).toUpperCase()}</div>
                <div className="student-avatar-info">
                  <span className="student-avatar-name">{studentData.name}</span>
                  <span className="student-avatar-meta">{activeStudentInfo.className} · Sem {activeStudentInfo.semester} · Grp {studentData.group}</span>
                </div>
              </div>
              <button className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
                onClick={() => { setActiveStudentInfo(null); setCurrentPage('landing'); setScanState(null); }}>
                Sign Out
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="student-tab-nav">
            <button
              className={`student-tab-btn ${studentTab === 'scan' ? 'active' : ''}`}
              onClick={async () => { setStudentTab('scan'); await refreshAttendanceLogs(studentData.id, activeStudentInfo.classId); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                <rect x="7" y="7" width="10" height="10" rx="1"/>
              </svg>
              Scan Attendance
            </button>
            <button
              className={`student-tab-btn ${studentTab === 'analytics' ? 'active' : ''}`}
              onClick={async () => { setStudentTab('analytics'); await refreshAttendanceLogs(studentData.id, activeStudentInfo.classId); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/><rect x="3" y="18" width="18" height="2" rx="1"/>
              </svg>
              My Analytics
            </button>
          </div>
        </header>

        {/* Main Content */}
        <main className="student-main-content">

          {/* ============================================================ */}
          {/* TAB 1: SCAN ATTENDANCE                                        */}
          {/* ============================================================ */}
          {studentTab === 'scan' && (
            <div className="scan-tab-content">

              {/* Today's status strip */}
              <div className="today-status-strip">
                <div className="today-strip-left">
                  <span className="today-strip-day">{todayDayName}</span>
                  <span className="today-strip-date">{new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
                </div>
                <div className="today-strip-right">
                  <div className="today-stat-pill">
                    <span className="today-stat-num">{todayLogs.filter(r => r.status === 'present').length}</span>
                    <span className="today-stat-label">Done Today</span>
                  </div>
                  <div className="today-stat-pill pending">
                    <span className="today-stat-num">{todayLogs.filter(r => r.status === 'pending').length}</span>
                    <span className="today-stat-label">In Progress</span>
                  </div>
                </div>
              </div>

              {/* SCAN RESULT CARD or SCAN BUTTON */}
              {!scanState ? (
                <div className="scan-center-card">
                  <div className="qr-radar-wrapper">
                    <div className={`qr-radar-ring ${scanAnimating ? 'scanning' : ''}`}>
                      <div className="qr-radar-inner">
                        {scanAnimating ? (
                          <div className="qr-scan-spinner">
                            <div className="qr-scan-line"></div>
                          </div>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="qr-icon-svg">
                            <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                            <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                            <rect x="7" y="7" width="10" height="10" rx="1"/>
                          </svg>
                        )}
                      </div>
                    </div>
                    {scanAnimating && (
                      <>
                        <div className="radar-pulse-ring r1"></div>
                        <div className="radar-pulse-ring r2"></div>
                        <div className="radar-pulse-ring r3"></div>
                      </>
                    )}
                  </div>

                  <h2 className="scan-card-title">
                    {scanAnimating ? 'Reading QR Code...' : 'Mark Your Attendance'}
                  </h2>
                  <p className="scan-card-subtitle">
                    {scanAnimating
                      ? 'Processing your scan. Please hold still.'
                      : 'Tap the button below to scan the QR code posted in your classroom to mark entry or exit.'}
                  </p>

                  {/* GCECT Geofencing Widget */}
                  {!scanAnimating && (
                    <div style={{
                      width: '100%',
                      padding: '0.85rem 1rem',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                      borderRadius: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      marginBottom: '1rem',
                      textAlign: 'left'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>
                          📍 Geofencing: <span style={{ color: 'var(--primary-light)' }}>GCECT Campus</span>
                        </span>
                        <span style={{
                          fontSize: '0.68rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '10px',
                          background: mockGcectLocation ? 'rgba(16, 185, 129, 0.12)' : 'rgba(124, 58, 237, 0.12)',
                          color: mockGcectLocation ? 'var(--accent-light)' : 'var(--primary-light)',
                          fontWeight: 700
                        }}>
                          {mockGcectLocation ? 'Mock Active' : 'Real GPS Active'}
                        </span>
                      </div>

                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--text-dim)', userSelect: 'none' }}>
                        <input
                          type="checkbox"
                          checked={mockGcectLocation}
                          onChange={(e) => setMockGcectLocation(e.target.checked)}
                          style={{ accentColor: 'var(--primary)' }}
                        />
                        Mock current location at GCECT Campus
                      </label>
                      
                      {geoChecking && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--primary-light)', display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
                          <span className="spinner-mini" style={{ width: '10px', height: '10px', border: '2px solid var(--primary-light)', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.6s linear infinite' }} />
                          Querying device GPS coordinates...
                        </div>
                      )}
                    </div>
                  )}

                  {pendingEntry && !scanAnimating && (
                    <div className="pending-entry-alert">
                      <span className="pending-alert-dot"></span>
                      <div>
                        <div className="pending-alert-label">Class In Progress</div>
                        <div className="pending-alert-subject">{pendingEntry.subjectName}</div>
                        <div className="pending-alert-meta">Entered at {formatTime(pendingEntry.entryTime)} · Exit opens at {minutesToDisplay(timeToMinutes(pendingEntry.periodEnd) - 5)}</div>
                      </div>
                    </div>
                  )}

                  <button
                    className={`btn-scan-qr ${scanAnimating ? 'disabled' : ''}`}
                    onClick={startCameraScanner}
                    disabled={scanAnimating}
                    id="scanQRBtn"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                      <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                      <rect x="7" y="7" width="10" height="10" rx="1"/>
                    </svg>
                    {scanAnimating ? 'Scanning...' : (pendingEntry ? '📷 Open Camera to Exit Class' : '📷 Open Camera to Scan QR')}
                  </button>
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.5rem', textAlign: 'center' }}>
                    Uses device camera to scan the official AttendX QR poster.
                  </p>

                  {/* CAMERA OVERLAY MODAL */}
                  {isScanning && (
                    <div className="login-modal-overlay active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: '1rem' }}>
                      <div className="login-modal-box animate-scale-up" style={{ width: '100%', maxWidth: '440px', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1rem', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                        <div className="modal-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
                          <span className="logo-text" style={{ fontSize: '1.05rem', fontWeight: '900', color: 'var(--primary-light)' }}>
                            📷 Camera QR Scanner
                          </span>
                          <button 
                            type="button" 
                            className="modal-close" 
                            onClick={stopCameraScanner}
                            style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '1.25rem', cursor: 'pointer' }}
                          >
                            ✕
                          </button>
                        </div>

                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
                          Please point your camera at the QR code displayed on the professor's screen.
                        </p>

                        <div 
                          id="reader" 
                          style={{ 
                            width: '100%', 
                            borderRadius: '12px', 
                            overflow: 'hidden', 
                            background: '#0a0a0e', 
                            border: '1.5px solid var(--border)',
                            boxShadow: 'inset 0 0 10px rgba(0,0,0,0.8)'
                          }}
                        ></div>

                        {scannerError && (
                          <div style={{ color: '#ef4444', fontSize: '0.72rem', textAlign: 'center', background: 'rgba(239, 68, 68, 0.08)', padding: '0.5rem', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                            ⚠️ {scannerError}
                          </div>
                        )}

                        <button 
                          type="button" 
                          className="btn-secondary" 
                          onClick={stopCameraScanner}
                          style={{ width: '100%', padding: '0.55rem', fontSize: '0.8rem' }}
                        >
                          Cancel Scanning
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* SCAN RESULT DISPLAY */
                <div className="scan-result-area">
                  {/* EXIT SUCCESS */}
                  {scanState.type === 'exit_success' && (
                    <div className="scan-result-card success">
                      <div className="scan-result-icon success-icon">✅</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <div className="scan-result-details-grid">
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Subject</span>
                          <span className="scan-detail-value">{scanState.subjectName}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Date</span>
                          <span className="scan-detail-value">{scanState.date}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Entry Time</span>
                          <span className="scan-detail-value">{scanState.entryTime}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Exit Time</span>
                          <span className="scan-detail-value">{scanState.exitTime}</span>
                        </div>
                        <div className="scan-detail-item full-width">
                          <span className="scan-detail-label">Duration in Class</span>
                          <span className="scan-detail-value accent-text">{scanState.duration}</span>
                        </div>
                      </div>
                      <div className="scan-confetti-badge">🎓 Attendance Marked — Present</div>
                      <button className="btn-primary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        Done
                      </button>
                    </div>
                  )}

                  {/* ENTRY SUCCESS */}
                  {scanState.type === 'entry_success' && (
                    <div className="scan-result-card entry">
                      {scanState.latePrevMessage && (
                        <div className="late-warning-banner">
                          <span>⚠️</span>
                          <span>{scanState.latePrevMessage}</span>
                        </div>
                      )}
                      <div className="scan-result-icon entry-icon">🚀</div>
                      <h2 className="scan-result-title">Entry Recorded!</h2>
                      <p className="scan-result-message">You've entered the classroom. Don't forget to scan again when the class ends!</p>
                      <div className="scan-result-details-grid">
                        <div className="scan-detail-item full-width">
                          <span className="scan-detail-label">Subject</span>
                          <span className="scan-detail-value">{scanState.subjectName}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Period Time</span>
                          <span className="scan-detail-value">{scanState.periodTime}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Your Entry</span>
                          <span className="scan-detail-value">{scanState.entryTime}</span>
                        </div>
                        {scanState.professors && (
                          <div className="scan-detail-item full-width">
                            <span className="scan-detail-label">Faculty</span>
                            <span className="scan-detail-value">{scanState.professors}</span>
                          </div>
                        )}
                        <div className="scan-detail-item full-width">
                          <span className="scan-detail-label">Exit Scan Opens At</span>
                          <span className="scan-detail-value accent-text">{scanState.exitOpenTime}</span>
                        </div>
                      </div>
                      <div className="exit-reminder-pill">
                        ⏰ Scan again after {scanState.exitOpenTime} to confirm attendance
                      </div>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        Back to Dashboard
                      </button>
                    </div>
                  )}

                  {/* EARLY ENTRY */}
                  {scanState.type === 'entry_early' && (
                    <div className="scan-result-card entry">
                      <div className="scan-result-icon" style={{ background: 'rgba(251,191,36,0.15)', color: '#f59e0b' }}>🕐</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <div className="scan-result-details-grid">
                        <div className="scan-detail-item full-width">
                          <span className="scan-detail-label">Subject</span>
                          <span className="scan-detail-value">{scanState.subjectName}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Class Time</span>
                          <span className="scan-detail-value">{scanState.periodTime}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Your Entry</span>
                          <span className="scan-detail-value">{scanState.entryTime}</span>
                        </div>
                      </div>
                      <p className="scan-result-message" style={{ color: 'var(--text-dim)', fontSize: '0.82rem' }}>{scanState.subMessage}</p>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        OK, Got It
                      </button>
                    </div>
                  )}

                  {/* TOO EARLY TO EXIT */}
                  {scanState.type === 'too_early_exit' && (
                    <div className="scan-result-card warning">
                      <div className="scan-result-icon warning-icon">⏳</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <div className="scan-result-details-grid">
                        <div className="scan-detail-item full-width">
                          <span className="scan-detail-label">Currently Attending</span>
                          <span className="scan-detail-value">{scanState.currentSubject}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">You Entered At</span>
                          <span className="scan-detail-value">{scanState.entryTime}</span>
                        </div>
                        <div className="scan-detail-item">
                          <span className="scan-detail-label">Exit Opens At</span>
                          <span className="scan-detail-value" style={{ color: '#f59e0b', fontWeight: '700' }}>{scanState.exitOpenTime}</span>
                        </div>
                      </div>
                      <p className="scan-result-message" style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>{scanState.subMessage}</p>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        Back
                      </button>
                    </div>
                  )}

                  {/* NO CLASS NOW */}
                  {(scanState.type === 'no_class_now' || scanState.type === 'no_class_today') && (
                    <div className="scan-result-card neutral">
                      <div className="scan-result-icon neutral-icon">{scanState.icon}</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      {scanState.subMessage && (
                        <p className="scan-result-message" style={{ color: 'var(--text-dim)', fontSize: '0.82rem' }}>{scanState.subMessage}</p>
                      )}
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1.5rem' }} onClick={handleScanAgain}>
                        Back
                      </button>
                    </div>
                  )}

                  {/* BLOCKED — exit previous class first */}
                  {(scanState.type === 'blocked_exit_pending') && (
                    <div className="scan-result-card warning">
                      <div className="scan-result-icon warning-icon">⚠️</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      {scanState.subMessage && (
                        <p className="scan-result-message" style={{ color: 'var(--text-dim)', fontSize: '0.82rem' }}>{scanState.subMessage}</p>
                      )}
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        Back
                      </button>
                    </div>
                  )}

                  {/* BLOCKED — stale previous-day entry */}
                  {scanState.type === 'blocked' && (
                    <div className="scan-result-card error">
                      <div className="scan-result-icon error-icon">🚫</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <p className="scan-result-message" style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>{scanState.subMessage}</p>
                      <button className="btn-primary" style={{ width: '100%', marginTop: '1rem', background: 'var(--error)' }}
                        onClick={handleForceCloseStalePending}>
                        Clear Stale Entry &amp; Continue
                      </button>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '0.5rem' }} onClick={handleScanAgain}>
                        Back
                      </button>
                    </div>
                  )}

                  {/* LATE ENTRY IN EXIT WINDOW */}
                  {scanState.type === 'entry_late_exit_window' && (
                    <div className="scan-result-card warning">
                      <div className="scan-result-icon warning-icon">⚠️</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <p className="scan-result-message" style={{ color: '#f59e0b', fontSize: '0.9rem', fontWeight: '700' }}>{scanState.subMessage}</p>
                      <button className="btn-primary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        OK — Will Scan Again to Exit
                      </button>
                    </div>
                  )}

                  {/* GEOLOCATION ERROR */}
                  {scanState.type === 'geo_error' && (
                    <div className="scan-result-card error">
                      <div className="scan-result-icon error-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: 'var(--error)' }}>{scanState.icon}</div>
                      <h2 className="scan-result-title">{scanState.title}</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <p className="scan-result-message" style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>{scanState.subMessage}</p>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1.5rem' }} onClick={handleScanAgain}>
                        Try Again
                      </button>
                    </div>
                  )}

                  {/* ERROR */}
                  {scanState.type === 'error' && (
                    <div className="scan-result-card error">
                      <div className="scan-result-icon error-icon">❌</div>
                      <h2 className="scan-result-title">Scan Failed</h2>
                      <p className="scan-result-message">{scanState.message}</p>
                      <button className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={handleScanAgain}>
                        Try Again
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Today's session log */}
              {todayLogs.length > 0 && (
                <div className="today-session-strip">
                  <div className="today-sessions-title">Today's Sessions</div>
                  {todayLogs.map(log => (
                    <div key={log.id} className={`today-session-item ${log.status}`}>
                      <div className="session-item-left">
                        <div className="session-subject">{log.subjectName}</div>
                        <div className="session-times">
                          Entry: {formatTime(log.entryTime)}
                          {log.exitTime ? ` · Exit: ${formatTime(log.exitTime)}` : ' · Exit: pending'}
                        </div>
                      </div>
                      <div className={`session-status-badge ${log.status}`}>
                        {log.status === 'present' ? '✓ Present' : log.status === 'pending' ? '⏳ Active' : '✗ Absent'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 2: ANALYTICS                                              */}
          {/* ============================================================ */}
          {studentTab === 'analytics' && (
            <div className="analytics-tab-content">

              {/* Overall ring card */}
              <div className="analytics-overview-card">
                <div className="analytics-ring-section">
                  <div className="analytics-ring-wrap">
                    <svg viewBox="0 0 100 100" className="analytics-ring-svg">
                      <defs>
                        <linearGradient id="analyticsRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor={overallPct >= 75 ? '#10b981' : overallPct >= 60 ? '#f59e0b' : '#ef4444'} />
                          <stop offset="100%" stopColor={overallPct >= 75 ? '#34d399' : overallPct >= 60 ? '#fbbf24' : '#f87171'} />
                        </linearGradient>
                      </defs>
                      <circle className="analytics-ring-track" cx="50" cy="50" r="45" />
                      <circle
                        className="analytics-ring-fill"
                        cx="50" cy="50" r="45"
                        strokeDasharray={`${ringFill} ${ringCircumference - ringFill}`}
                        strokeDashoffset={ringCircumference * 0.25}
                        stroke="url(#analyticsRingGrad)"
                      />
                    </svg>
                    <div className="analytics-ring-center">
                      <span className="analytics-ring-pct">{overallPct}%</span>
                      <span className="analytics-ring-label">Overall</span>
                    </div>
                  </div>
                  <div className="analytics-overview-stats">
                    <div className="analytics-stat-pill green">
                      <span className="analytics-stat-num">{totalAttended}</span>
                      <span className="analytics-stat-label">Classes Attended</span>
                    </div>
                    <div className="analytics-stat-pill">
                      <span className="analytics-stat-num">{attendanceLogs.filter(r => r.status === 'absent_no_exit').length}</span>
                      <span className="analytics-stat-label">Incomplete Exits</span>
                    </div>
                    <div className="analytics-stat-pill">
                      <span className="analytics-stat-num">{attendanceLogs.filter(r => r.date === today).length}</span>
                      <span className="analytics-stat-label">Today's Scans</span>
                    </div>
                    <div className={`analytics-stat-pill ${overallPct >= 75 ? 'green' : overallPct >= 60 ? 'yellow' : 'red'}`}>
                      <span className="analytics-stat-num">{overallPct >= 75 ? '✓ Safe' : overallPct >= 60 ? '⚠ At Risk' : '✗ Danger'}</span>
                      <span className="analytics-stat-label">Attendance Status</span>
                    </div>
                  </div>
                </div>

                <div className="analytics-student-meta">
                  <div className="analytics-meta-item">
                    <span className="analytics-meta-label">Student</span>
                    <span className="analytics-meta-value">{studentData.name}</span>
                  </div>
                  <div className="analytics-meta-item">
                    <span className="analytics-meta-label">Roll No.</span>
                    <span className="analytics-meta-value">{studentData.roll}</span>
                  </div>
                  <div className="analytics-meta-item">
                    <span className="analytics-meta-label">Class</span>
                    <span className="analytics-meta-value">{activeStudentInfo.className}</span>
                  </div>
                  <div className="analytics-meta-item">
                    <span className="analytics-meta-label">Program</span>
                    <span className="analytics-meta-value">{activeStudentInfo.program} · Sem {activeStudentInfo.semester}</span>
                  </div>
                </div>
              </div>

              {/* Per-subject breakdown */}
              <div className="analytics-section-card">
                <div className="analytics-section-header">
                  <h3 className="analytics-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px' }}>
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                    </svg>
                    Subject-Wise Attendance
                  </h3>
                </div>

                {subjectStats.length === 0 ? (
                  <div className="analytics-empty-state">
                    <span style={{ fontSize: '2.5rem' }}>📋</span>
                    <p>No attendance records yet. Start scanning QR codes to track your attendance.</p>
                  </div>
                ) : (
                  <div className="subject-analytics-list">
                    {subjectStats.map((sub, idx) => {
                      const pct = sub.totalExpected > 0 ? Math.round((sub.attended / sub.totalExpected) * 100) : 100;
                      const needed75 = sub.totalExpected > 0 ? Math.max(0, Math.ceil(0.75 * sub.totalExpected) - sub.attended) : 0;
                      const statusClass = pct >= 75 ? 'safe' : pct >= 60 ? 'risk' : 'danger';
                      const statusLabel = pct >= 75 ? 'Safe' : pct >= 60 ? 'At Risk' : 'Danger';
                      return (
                        <div key={idx} className="subject-analytics-row">
                          <div className="subject-analytics-top">
                            <div className="subject-analytics-name">
                              {sub.subjectName}
                              <span className={`sub-badge ${sub.type.toLowerCase()}`} style={{ fontSize: '0.6rem', marginLeft: '0.4rem' }}>{sub.type}</span>
                            </div>
                            <div className="subject-analytics-right">
                              <span className="subject-analytics-count">{sub.attended}/{sub.totalExpected}</span>
                              <span className={`subject-status-badge ${statusClass}`}>{statusLabel}</span>
                            </div>
                          </div>
                          <div className="subject-progress-bar-bg">
                            <div
                              className={`subject-progress-bar-fill ${statusClass}`}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            ></div>
                            <div className="subject-progress-threshold" style={{ left: '75%' }} title="75% threshold"></div>
                          </div>
                          <div className="subject-analytics-bottom">
                            <span className="subject-pct-label">{pct}% attendance</span>
                            {needed75 > 0 && (
                              <span className="subject-warning-label">⚠ Attend {needed75} more to reach 75%</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Session History Log */}
              <div className="analytics-section-card">
                <div className="analytics-section-header">
                  <h3 className="analytics-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px' }}>
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    Session History
                  </h3>
                  <span className="analytics-count-badge">{attendanceLogs.length} total</span>
                </div>

                {attendanceLogs.length === 0 ? (
                  <div className="analytics-empty-state">
                    <span style={{ fontSize: '2.5rem' }}>🕐</span>
                    <p>No sessions recorded yet. Your attendance history will appear here after you start scanning.</p>
                  </div>
                ) : (
                  <div className="session-log-table-wrap">
                    <table className="session-log-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Subject</th>
                          <th>Entry</th>
                          <th>Exit</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...attendanceLogs].reverse().map(log => {
                          const duration = log.exitTime && log.entryTime
                            ? `${Math.round((new Date(log.exitTime) - new Date(log.entryTime)) / 60000)} min`
                            : '—';
                          return (
                            <tr key={log.id} className={`session-log-row ${log.status}`}>
                              <td className="session-log-date">{formatDate(log.entryTime)}</td>
                              <td className="session-log-subject">{log.subjectName}</td>
                              <td>{formatTime(log.entryTime)}</td>
                              <td>{log.exitTime ? formatTime(log.exitTime) : <span style={{ color: 'var(--text-dim)' }}>—</span>}</td>
                              <td>{duration}</td>
                              <td>
                                <span className={`session-status-badge ${log.status}`}>
                                  {log.status === 'present' ? '✓ Present'
                                    : log.status === 'pending' ? '⏳ Active'
                                    : log.status === 'absent_no_exit' ? '✗ Incomplete'
                                    : log.status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Today's Schedule from Routine */}
              <div className="analytics-section-card">
                <div className="analytics-section-header">
                  <h3 className="analytics-section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px' }}>
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/>
                      <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                    Today's Schedule — {todayDayName}
                  </h3>
                </div>

                {(() => {
                  const todayRoutine = routine
                    .filter(p => p.day === todayDayName)
                    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

                  if (todayRoutine.length === 0) {
                    return (
                      <div className="analytics-empty-state">
                        <span style={{ fontSize: '2rem' }}>🎉</span>
                        <p>No classes scheduled for {todayDayName}. Enjoy your day!</p>
                      </div>
                    );
                  }

                  return (
                    <div className="today-schedule-list">
                      {todayRoutine.map(period => {
                        const subInfo = getPeriodSubjectInfo(period, studentData.group);
                        const periodLog = todayLogs.find(l => l.periodId === period.id);
                        const now = new Date();
                        const nowMin = now.getHours() * 60 + now.getMinutes();
                        const startMin = timeToMinutes(period.startTime);
                        const endMin = timeToMinutes(period.endTime);
                        const isActive = nowMin >= startMin - 15 && nowMin < endMin;
                        const isPast = nowMin >= endMin;

                        return (
                          <div key={period.id} className={`schedule-period-row ${isActive ? 'active' : isPast ? 'past' : 'upcoming'}`}>
                            <div className="schedule-time-col">
                              <span className="schedule-start">{minutesToDisplay(startMin)}</span>
                              <div className="schedule-time-divider"></div>
                              <span className="schedule-end">{minutesToDisplay(endMin)}</span>
                            </div>
                            <div className="schedule-info-col">
                              <div className="schedule-subject">{subInfo?.subjectName || period.type}</div>
                              <div className="schedule-meta">
                                <span className={`sub-badge ${period.type.toLowerCase()}`} style={{ fontSize: '0.62rem' }}>{period.type}</span>
                                {subInfo?.professors && <span className="schedule-prof">👨‍🏫 {subInfo.professors.map(p => p.name).join(', ')}</span>}
                              </div>
                            </div>
                            <div className="schedule-status-col">
                              {periodLog ? (
                                <span className={`session-status-badge ${periodLog.status}`}>
                                  {periodLog.status === 'present' ? '✓ Done' : periodLog.status === 'pending' ? '⏳ Active' : '✗'}
                                </span>
                              ) : isPast ? (
                                <span className="session-status-badge absent_no_exit">✗ Missed</span>
                              ) : isActive ? (
                                <span className="session-status-badge pending">Now</span>
                              ) : (
                                <span className="session-status-badge upcoming">Upcoming</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

            </div>
          )}
        </main>

        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              <span className="toast-icon">{toast.type === 'success' ? '✅' : '❌'}</span>
              <span>{toast.message}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Conditional rendering for Professor Portal Dashboard
  if (currentPage === 'professor_dashboard' && activeProfessorInfo) {
    const profData = activeProfessorInfo.professor;
    const profId = profData.id;

    // Scan classes to identify which ones are taught by this professor in the routine
    const profClasses = classes.map(cls => {
      let isTaught = false;
      const taughtSubjects = [];
      
      const routine = cls.routine || [];
      routine.forEach(p => {
        if (p.type === 'Theory') {
          if (p.professors?.some(pr => pr.id === profId)) {
            isTaught = true;
            if (!taughtSubjects.some(s => s.id === p.subjectId)) {
              taughtSubjects.push({ id: p.subjectId, name: p.subjectName, type: 'Theory' });
            }
          }
        } else {
          // Practical
          if (p.groupA?.professors?.some(pr => pr.id === profId)) {
            isTaught = true;
            if (!taughtSubjects.some(s => s.id === p.groupA.subjectId)) {
              taughtSubjects.push({ id: p.groupA.subjectId, name: p.groupA.subjectName, type: 'Practical' });
            }
          }
          if (p.groupB?.professors?.some(pr => pr.id === profId)) {
            isTaught = true;
            if (!taughtSubjects.some(s => s.id === p.groupB.subjectId)) {
              taughtSubjects.push({ id: p.groupB.subjectId, name: p.groupB.subjectName, type: 'Practical' });
            }
          }
        }
      });

      return {
        ...cls,
        isTaught,
        taughtSubjects
      };
    });

    const currentClass = selectedProfClass ? classes.find(c => c.id === selectedProfClass.id) : null;
    
    // Find subjects taught by this professor in currentClass
    const classSubjects = currentClass 
      ? (profClasses.find(c => c.id === currentClass.id)?.taughtSubjects || [])
      : [];

    const currentSub = selectedProfSubject || (classSubjects.length > 0 ? classSubjects[0] : null);

    // If currentClass is selected but currentSub is null and we have classSubjects, set it
    if (currentClass && classSubjects.length > 0 && !selectedProfSubject) {
      setSelectedProfSubject(classSubjects[0]);
    }

    // Filter logs for this class and subject
    const classSubLogs = (currentClass && currentSub)
      ? profAllAttendanceLogs.filter(log => log.classId === currentClass.id && (log.subjectId === currentSub.id || log.subjectName === currentSub.name))
      : [];

    // Unique Sessions Conducted
    const sessionsMap = {};
    classSubLogs.forEach(log => {
      const key = `${log.date}_${log.periodId || log.periodStart}`;
      if (!sessionsMap[key]) {
        sessionsMap[key] = {
          key,
          date: log.date,
          periodId: log.periodId,
          periodStart: log.periodStart,
          periodEnd: log.periodEnd,
          presentCount: 0,
          totalCount: 0
        };
      }
      if (log.exitTime && log.status === 'present') {
        sessionsMap[key].presentCount += 1;
      }
    });
    const sessionsList = Object.values(sessionsMap).sort((a, b) => b.date.localeCompare(a.date));

    // Sessions by group for Practical or Theory
    const groupASessions = new Set();
    const groupBSessions = new Set();
    const allSessionsSet = new Set();
    classSubLogs.forEach(log => {
      const key = `${log.date}_${log.periodId || log.periodStart}`;
      allSessionsSet.add(key);

      const stu = currentClass?.students?.find(s => s.id === log.studentId);
      if (stu) {
        if (stu.group === 'A') {
          groupASessions.add(key);
        } else if (stu.group === 'B') {
          groupBSessions.add(key);
        }
      }
    });

    // Map student analytics
    const studentStats = currentClass ? currentClass.students.map(student => {
      const studentLogs = classSubLogs.filter(log => log.studentId === student.id);
      const attendedCount = studentLogs.filter(log => log.exitTime && log.status === 'present').length;
      
      let totalExpected = allSessionsSet.size;
      if (currentSub && currentSub.type === 'Practical') {
        totalExpected = student.group === 'B' ? groupBSessions.size : groupASessions.size;
      }

      const pct = totalExpected > 0 ? Math.round((attendedCount / totalExpected) * 100) : 100;
      
      let status = 'safe'; // safe | risk | danger
      if (pct < 60) status = 'danger';
      else if (pct < 75) status = 'risk';

      return {
        ...student,
        attendedCount,
        totalExpected,
        pct,
        status,
        logs: studentLogs
      };
    }) : [];

    const totalEnrolled = currentClass ? currentClass.students.length : 0;
    const avgAttendance = studentStats.length > 0 
      ? Math.round(studentStats.reduce((acc, s) => acc + s.pct, 0) / studentStats.length)
      : 0;
    const atRiskCount = studentStats.filter(s => s.pct < 75).length;
    const totalSessionsConducted = currentSub?.type === 'Practical'
      ? (groupASessions.size + groupBSessions.size)
      : allSessionsSet.size;

    // Filter students
    const filteredStudents = studentStats.filter(student => {
      const matchesSearch = student.name.toLowerCase().includes(profSearchQuery.toLowerCase()) ||
                            student.roll.toLowerCase().includes(profSearchQuery.toLowerCase());
      const matchesStatus = profFilterStatus === 'all' || student.status === profFilterStatus;
      const matchesGroup = profFilterGroup === 'all' || student.group === profFilterGroup;
      return matchesSearch && matchesStatus && matchesGroup;
    });

    let deptClass = 'cs';
    if (profData.department === 'Information Technology') deptClass = 'it';
    if (profData.department === 'Ceramic Technology') deptClass = 'cer';
    if (profData.department === 'Basic Sciences and Humanities') deptClass = 'bsh';

    const handleClassClick = (cls) => {
      setSelectedProfClass(cls);
      setSelectedProfSubject(null);
      setProfSearchQuery('');
      setProfFilterStatus('all');
      setProfFilterGroup('all');
      setSelectedProfStudent(null);
    };

    const handleSubjectChange = (e) => {
      const subId = e.target.value;
      const sub = classSubjects.find(s => s.id === subId);
      if (sub) {
        setSelectedProfSubject(sub);
      }
    };

    return (
      <div className="student-portal-container animate-fade-in">
        {/* Ambient background */}
        <div className="hero-bg" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}>
          <div className="orb orb-3" style={{ opacity: 0.3 }}></div>
          <div className="grid-overlay"></div>
        </div>

        {/* Professor Header */}
        <header className="student-header">
          <div className="student-header-inner">
            <div className="nav-logo">
              <span className="logo-icon">◈</span>
              <span className="logo-text">Attend<span className="accent">X</span></span>
            </div>
            <div className="student-header-profile">
              <div className="student-avatar-chip">
                <div className="student-avatar-circle" style={{ background: 'linear-gradient(135deg, var(--primary), #ec4899)' }}>
                  {profData.name.charAt(0).toUpperCase()}
                </div>
                <div className="student-avatar-info">
                  <span className="student-avatar-name">{profData.name}</span>
                  <span className="student-avatar-meta">{profData.department}</span>
                </div>
              </div>
              <button className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}
                onClick={() => { setActiveProfessorInfo(null); setCurrentPage('landing'); setSelectedProfClass(null); }}>
                Sign Out
              </button>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="student-main-content">
          {!currentClass ? (
            /* VIEW A: CLASS LIST */
            <div className="scan-tab-content">
              <div className="section-label">Faculty Workspace</div>
              <h2 className="section-title">My Classes &amp; Subjects</h2>
              <p className="section-sub">Select any class below to inspect student attendance registries and session history records.</p>

              {/* Class Cards Grid */}
              <div className="features-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                {profClasses.map(cls => (
                  <div key={cls.id} className="feature-card" style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '200px' }}
                    onClick={() => handleClassClick(cls)}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                        <span className="subject-analytics-name" style={{ fontSize: '1.1rem' }}>{cls.name}</span>
                        <span className={`session-status-badge ${cls.isTaught ? 'present' : 'upcoming'}`}>
                          {cls.isTaught ? 'Assigned' : 'View Only'}
                        </span>
                      </div>
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '0.75rem' }}>
                        {cls.program} · Semester {cls.semester}
                      </p>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', margin: '0.5rem 0' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Taught Subjects:</span>
                        {cls.taughtSubjects.map((sub, idx) => (
                          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', padding: '0.2rem 0.4rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                            <span>{sub.name}</span>
                            <span style={{ color: 'var(--primary-light)', fontWeight: 600 }}>{sub.type}</span>
                          </div>
                        ))}
                        {cls.taughtSubjects.length === 0 && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>None scheduled in routine</span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>👤 {cls.students?.length || 0} Students</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--primary-light)', fontWeight: 700 }}>Inspect →</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* VIEW B: CLASS DETAIL ANALYTICS */
            renderClassDetailAnalytics()
          )}
        </main>

        {/* MODAL 1: STUDENT HISTORY LOGS */}
        {renderStudentLogsModal()}

        {/* MODAL 2: ATTENDANCE QR CODE MODAL FOR PROFESSORS */}
        {activeQRClass && (
          <div className="login-modal-overlay active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
            <div className="login-modal-box animate-scale-up" style={{ maxWidth: '440px', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '1rem' }}>
              
              <div className="modal-header-row" style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="logo-text" style={{ fontSize: '1.1rem', fontWeight: '900', color: 'var(--primary-light)' }}>
                  ◈ AttendX Poster Panel
                </span>
                <button 
                  type="button" 
                  className="modal-close" 
                  onClick={() => setActiveQRClass(null)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: '1.25rem', cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>

              <div style={{ marginTop: '0.5rem' }}>
                <h2 style={{ fontSize: '1.4rem', fontFamily: 'Outfit', fontWeight: '900', margin: '0 0 0.25rem 0', color: 'var(--text)' }}>
                  {activeQRClass.name}
                </h2>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
                  {activeQRClass.program} • Semester {activeQRClass.semester} • Batch {activeQRClass.batchStart}-{activeQRClass.batchEnd}
                </p>
              </div>

              {/* Stylish QR Code Canvas Wrapper */}
              <div style={{ background: '#ffffff', padding: '1.25rem', borderRadius: '16px', boxShadow: '0 10px 30px rgba(139, 92, 246, 0.15)', margin: '1rem 0' }}>
                <canvas ref={qrCanvasRef} style={{ width: '240px', height: '240px', display: 'block' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                <button 
                  type="button" 
                  className="btn-primary" 
                  style={{ width: '100%', padding: '0.65rem' }} 
                  onClick={() => {
                    if (qrCanvasRef.current) {
                      const qrDataUrl = qrCanvasRef.current.toDataURL('image/png');
                      const printWindow = window.open('', '_blank');
                      printWindow.document.write(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                          <title>Attendance QR Poster - ${activeQRClass.name}</title>
                          <style>
                            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background: #fafafa; padding: 2rem; color: #1e1b4b; }
                            .poster { background: #ffffff; padding: 3rem; border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.06); max-width: 500px; margin: 0 auto; border: 2px solid #e0e0e0; }
                            .logo { font-size: 1.5rem; font-weight: 800; color: #6d28d9; letter-spacing: -0.5px; margin-bottom: 2rem; }
                            .class-name { font-size: 2.2rem; font-weight: 900; margin: 0; }
                            .class-meta { color: #64748b; font-size: 1rem; margin-top: 0.5rem; margin-bottom: 2rem; }
                            .qr-container { padding: 1.5rem; border: 1px solid #e2e8f0; border-radius: 20px; display: inline-block; margin-bottom: 2rem; }
                            .instructions { font-size: 1.1rem; color: #475569; line-height: 1.6; max-width: 380px; margin: 0 auto; }
                            .footer { margin-top: 3rem; font-size: 0.85rem; color: #94a3b8; }
                          </style>
                        </head>
                        <body>
                          <div class="poster">
                            <div class="logo">◈ AttendX</div>
                            <div class="class-name">${activeQRClass.name}</div>
                            <div class="class-meta">${activeQRClass.program} &bull; Semester ${activeQRClass.semester} &bull; Batch ${activeQRClass.batchStart}-${activeQRClass.batchEnd}</div>
                            <div class="qr-container">
                              <img src="${qrDataUrl}" style="width: 320px; height: 320px; display: block;" />
                            </div>
                            <div class="instructions">
                              Scan this QR code using the <strong>AttendX student portal</strong> to register your entry/exit session attendance.
                            </div>
                            <div class="footer">Generated automatically via AttendX Faculty Terminal Console</div>
                          </div>
                          <script>window.onload = function() { window.print(); }</script>
                        </body>
                        </html>
                      `);
                      printWindow.document.close();
                    }
                  }}
                >
                  Print QR Poster Panel
                </button>
                <button 
                  type="button" 
                  className="btn-secondary" 
                  style={{ width: '100%', padding: '0.65rem' }} 
                  onClick={() => setActiveQRClass(null)}
                >
                  Dismiss Panel
                </button>
              </div>

            </div>
          </div>
        )}

        {/* MODAL 3: ADJUST SCHEDULE TIMETABLE SLOT */}
        {renderAdjustmentModal()}

        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              <span className="toast-icon">{toast.type === 'success' ? '✅' : '❌'}</span>
              <span>{toast.message}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* ===== NAVBAR ===== */}
      <nav className={`navbar ${scrolled ? 'scrolled' : ''}`} id="navbar">
        <div className="nav-container">
          <div className="nav-logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="logo-icon">◈</span>
            <span className="logo-text">Attend<span className="accent">X</span></span>
          </div>
          <div className={`nav-links ${mobileMenuOpen ? 'mobile-open' : ''}`} id="navLinks">
            <a href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
            <a href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
          </div>
          <div className="nav-actions">
            <button className="btn-login" id="navLoginBtn" onClick={() => openLoginModal('student')}>
              <span className="btn-login-text">Login</span>
              <span className="btn-login-icon">→</span>
            </button>
            <button className="hamburger" id="hamburger" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
              <span style={{ transform: mobileMenuOpen ? 'rotate(45deg) translate(5px, 5px)' : 'none' }}></span>
              <span style={{ opacity: mobileMenuOpen ? 0 : 1 }}></span>
              <span style={{ transform: mobileMenuOpen ? 'rotate(-45deg) translate(5px, -5px)' : 'none' }}></span>
            </button>
          </div>
        </div>
      </nav>

      {/* ===== HERO SECTION ===== */}
      <section className="hero" id="home">
        <div className="hero-bg">
          <div className="orb orb-1"></div>
          <div className="orb orb-2"></div>
          <div className="orb orb-3"></div>
          <div className="grid-overlay"></div>
        </div>

        <div className="hero-content">
          <div className="hero-badge">
            <span className="badge-dot"></span>
            <span>Next-Gen Attendance Platform</span>
          </div>
          <h1 className="hero-title">
            Smart Attendance,<br />
            <span className="gradient-text">Zero Hassle.</span>
          </h1>
          <p className="hero-subtitle">
            Streamline attendance tracking for your entire college. Real-time insights, 
            automated reports, and seamless management for students and professors alike.
          </p>

          <div className="hero-cta">
            <button className="btn-primary" onClick={() => openLoginModal('student')}>
              <span>Student Login</span>
              <div className="btn-glow"></div>
            </button>
            <button className="btn-secondary" onClick={() => openLoginModal('professor')}>
              <span>Professor Login</span>
            </button>
          </div>
        </div>

        <div className="hero-visual">
          <div className="dashboard-card">
            <div className="card-header">
              <div className="card-title">Today's Attendance</div>
              <div className="card-badge live">● LIVE</div>
            </div>
            <div className="attendance-ring-wrap">
              <svg className="ring-svg" viewBox="0 0 120 120">
                <defs>
                  <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#a78bfa" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                </defs>
                <circle className="ring-track" cx="60" cy="60" r="50" />
                <circle className="ring-fill" cx="60" cy="60" r="50" />
              </svg>
              <div className="ring-center">
                <span className="ring-pct">87%</span>
                <span className="ring-sub">Present</span>
              </div>
            </div>
            <div className="card-stats-row">
              <div className="mini-stat">
                <span className="mini-num green">217</span>
                <span className="mini-label">Present</span>
              </div>
              <div className="mini-stat">
                <span className="mini-num orange">32</span>
                <span className="mini-label">Absent</span>
              </div>
              <div className="mini-stat">
                <span className="mini-num purple">5</span>
                <span className="mini-label">Late</span>
              </div>
            </div>
            <div className="card-subjects">
              <div className="subject-row">
                <span className="subject-name">Data Structures</span>
                <div className="subject-bar"><div className="subject-fill" style={{ width: '92%' }}></div></div>
                <span className="subject-pct">92%</span>
              </div>
              <div className="subject-row">
                <span className="subject-name">Algorithms</span>
                <div className="subject-bar"><div className="subject-fill" style={{ width: '78%' }}></div></div>
                <span className="subject-pct">78%</span>
              </div>
              <div className="subject-row">
                <span className="subject-name">OS Theory</span>
                <div className="subject-bar"><div className="subject-fill" style={{ width: '85%' }}></div></div>
                <span className="subject-pct">85%</span>
              </div>
            </div>
          </div>

          {/* Floating cards */}
          <div className="float-card fc-1">
            <span className="fc-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div>
              <div className="fc-title">Marked Present</div>
              <div className="fc-sub">CSE - Section A</div>
            </div>
          </div>
          <div className="float-card fc-2">
            <span className="fc-icon alert">!</span>
            <div>
              <div className="fc-title">Low Attendance Alert</div>
              <div className="fc-sub">Riya S. – 63%</div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== FEATURES ===== */}
      <section className="features" id="features">
        <div className="section-label">Core Features</div>
        <h2 className="section-title">Everything you need to<br /><span className="gradient-text">manage attendance</span></h2>
        <p className="section-sub">Powerful tools designed for modern colleges — from real-time tracking to smart analytics.</p>

        <div className="features-grid">
          <div className="feature-card fc-big">
            <div className="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
              </svg>
            </div>
            <h3>Real-Time Tracking</h3>
            <p>Mark and monitor attendance instantly. Live dashboards refresh automatically so professors always have up-to-date data.</p>
            <div className="feature-tag">Live Updates</div>
          </div>
          
          <div className="feature-card">
            <div className="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <h3>Smart Analytics</h3>
            <p>Visual reports, trends, and alerts help you act before attendance issues escalate.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <h3>Auto Alerts</h3>
            <p>Students below threshold automatically receive alerts. Professors get summary digests.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <h3>One-Click Reports</h3>
            <p>Export attendance sheets in PDF or Excel with a single click — ready for academic records.</p>
          </div>

          <div className="feature-card fc-wide">
            <div className="feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h3>Role-Based Access</h3>
            <p>Students see their own data. Professors manage their classes. Admins oversee everything — all with secure, role-based authentication.</p>
            <div className="feature-tag">Secure</div>
          </div>
        </div>
      </section>

      {/* ===== HOW IT WORKS ===== */}
      <section className="how-it-works" id="how-it-works">
        <div className="section-label">Simple Process</div>
        <h2 className="section-title">How <span className="gradient-text">AttendX</span> works</h2>
        <p className="section-sub">No manual marking. Professors generate a session QR — students scan and they're in.</p>

        <div className="steps-grid steps-grid-4">
          <div className="step-card">
            <div className="step-num">01</div>
            <div className="step-icon-svg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M14 14h.01M14 17h.01M17 14h.01M20 14h.01M20 17h.01M17 20h.01M20 20h.01M17 17h.01" />
              </svg>
            </div>
            <h3>Professor Starts Class</h3>
            <p>The professor logs in, selects the subject and section, and generates a unique time-limited <strong>QR code</strong> for that session.</p>
          </div>

          <div className="step-connector">→</div>

          <div className="step-card">
            <div className="step-num">02</div>
            <div className="step-icon-svg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2" />
                <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                <rect x="7" y="7" width="10" height="10" rx="1" />
              </svg>
            </div>
            <h3>Students Scan QR</h3>
            <p>Students open the AttendX app or portal, scan the displayed QR code on their phone — <strong>no manual roll-call</strong> needed.</p>
          </div>

          <div className="step-connector">→</div>

          <div className="step-card">
            <div className="step-num">03</div>
            <div className="step-icon-svg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <h3>Attendance Auto-Logged</h3>
            <p>The system instantly verifies the student's identity and marks them present. The professor's dashboard updates <strong>in real time</strong>.</p>
          </div>

          <div className="step-connector">→</div>

          <div className="step-card">
            <div className="step-num">04</div>
            <div className="step-icon-svg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
                <rect x="3" y="18" width="18" height="2" rx="1" />
              </svg>
            </div>
            <h3>Reports &amp; Insights</h3>
            <p>Attendance data is aggregated into smart dashboards. Students get alerts if attendance drops below the required threshold.</p>
          </div>
        </div>
      </section>

      {/* ===== FOOTER ===== */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-logo">
            <span className="logo-icon">◈</span>
            <span className="logo-text">Attend<span className="accent">X</span></span>
          </div>
          <p className="footer-tagline">Smart Attendance for Modern Colleges</p>
          <div className="footer-links">
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Use</a>
            <a href="#">Support</a>
            <a href="#">Contact</a>
          </div>
          <p className="footer-copy">© 2026 AttendX. All rights reserved.</p>
        </div>
      </footer>

      {/* ===== LOGIN MODAL ===== */}
      {modalOpen && (
        <div className="modal-overlay open" onClick={(e) => e.target.classList.contains('modal-overlay') && closeLoginModal()}>
          <div className="modal" id="loginModalBox">
            {/* Modal Top Bar */}
            <div className="modal-top-bar">
              <span className="modal-top-label" id="modalTopLabel">
                {role === 'student' ? 'Student Login' : 'Professor Login'}
              </span>
              <button className="modal-close" onClick={closeLoginModal}>✕</button>
            </div>

            {/* Toggle Switch */}
            <div className="modal-toggle">
              <button
                className={`toggle-btn ${role === 'student' ? 'active' : ''}`}
                id="toggleStudent"
                onClick={() => switchRole('student')}
              >
                <span className="toggle-icon">{capIcon}</span> Student
              </button>
              <button
                className={`toggle-btn ${role === 'professor' ? 'active' : ''}`}
                id="toggleProfessor"
                onClick={() => switchRole('professor')}
              >
                <span className="toggle-icon">{userGroupIcon}</span> Professor
              </button>
              <div className={`toggle-slider ${role === 'professor' ? 'professor' : ''}`} id="toggleSlider"></div>
            </div>

            {/* Modal Header */}
            <div className="modal-header">
              <div className="modal-avatar" id="modalAvatar">
                {role === 'student' ? capIcon : professorAvatarIcon}
              </div>
              <h2 className="modal-title" id="modalTitle">
                {role === 'student' ? 'Student Login' : 'Professor Login'}
              </h2>
              <p className="modal-subtitle" id="modalSubtitle">
                {role === 'student' ? 'Enter your student credentials to continue' : 'Enter your professor credentials to continue'}
              </p>
            </div>

            {/* Form */}
            <form className="login-form" id="loginForm" onSubmit={handleLoginSubmit}>
              <div className="form-group">
                <label className="form-label" id="idLabel" htmlFor="userId">
                  {role === 'student' ? 'Student ID' : 'Professor ID'}
                </label>
                <div className="input-wrap">
                  <span className="input-icon" id="idIcon">
                    {role === 'student' ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    ) : professorIdIcon}
                  </span>
                  <input
                    className="form-input"
                    type="text"
                    id="userId"
                    placeholder={role === 'student' ? 'e.g. STU2026001' : 'e.g. PRF2026001'}
                    autoComplete="off"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="userPassword">Password</label>
                <div className="input-wrap">
                  <span className="input-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    className="form-input"
                    type={passwordVisible ? 'text' : 'password'}
                    id="userPassword"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="toggle-pass"
                    onClick={() => setPasswordVisible(!passwordVisible)}
                    id="togglePassBtn"
                  >
                    {passwordVisible ? eyeClosedIcon : eyeOpenIcon}
                  </button>
                </div>
              </div>

              <div className="form-options">
                <label className="checkbox-wrap">
                  <input
                    type="checkbox"
                    id="rememberMe"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                  />
                  <span className="checkbox-box"></span>
                  <span>Remember me</span>
                </label>
              </div>

              <button
                type="submit"
                className={`btn-submit ${role === 'professor' ? 'professor-submit' : ''} ${loading ? 'loading' : ''}`}
                id="submitBtn"
                disabled={loading}
              >
                <span id="submitText">Login as {role === 'student' ? 'Student' : 'Professor'}</span>
                <div className="submit-loader" id="submitLoader"></div>
              </button>

              <p className="form-note" id="formNote">
                Protected by end-to-end encryption &nbsp;[🔐]
              </p>
            </form>
          </div>
        </div>
      )}

      {/* ===== TOAST NOTIFICATIONS ===== */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>
            <span className="toast-icon">{toast.type === 'success' ? '✅' : '❌'}</span>
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </>
  );
}
