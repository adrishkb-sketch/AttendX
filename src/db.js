import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  doc, 
  getDocs, 
  setDoc, 
  deleteDoc, 
  query, 
  where,
  writeBatch
} from 'firebase/firestore';

// Read environmental variables for Firebase Spark free tier
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const isFirebaseConfigured = !!(
  firebaseConfig.apiKey && 
  firebaseConfig.projectId && 
  firebaseConfig.appId
);

let db = null;
if (isFirebaseConfigured) {
  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  } catch (err) {
    console.warn("Failed to initialize Firebase client:", err);
  }
}

export function getFirestoreDb() {
  return db;
}

// ===================================================
// LOCAL STORAGE BACKUPS & UTILITIES
// ===================================================

const getLocalClasses = () => {
  const data = localStorage.getItem('attendx_classes');
  return data ? JSON.parse(data) : [];
};
const saveLocalClasses = (classes) => {
  localStorage.setItem('attendx_classes', JSON.stringify(classes));
};

const getLocalAttendance = () => {
  const data = localStorage.getItem('attendx_attendance');
  return data ? JSON.parse(data) : [];
};
const saveLocalAttendance = (logs) => {
  localStorage.setItem('attendx_attendance', JSON.stringify(logs));
};

const getLocalSubjects = () => {
  const data = localStorage.getItem('attendx_subjects');
  return data ? JSON.parse(data) : [];
};
const saveLocalSubjects = (subjects) => {
  localStorage.setItem('attendx_subjects', JSON.stringify(subjects));
};

const getLocalProfessors = () => {
  const data = localStorage.getItem('attendx_professors');
  return data ? JSON.parse(data) : [];
};
const saveLocalProfessors = (professors) => {
  localStorage.setItem('attendx_professors', JSON.stringify(professors));
};

const getLocalProfSubjects = () => {
  const data = localStorage.getItem('attendx_professor_subjects');
  return data ? JSON.parse(data) : [];
};
const saveLocalProfSubjects = (junctions) => {
  localStorage.setItem('attendx_professor_subjects', JSON.stringify(junctions));
};

// ===================================================
// CLASSES & STUDENTS DATABASE APIS
// ===================================================

export async function getClasses() {
  if (db) {
    try {
      const classesSnap = await getDocs(collection(db, 'classes'));
      const studentsSnap = await getDocs(collection(db, 'students'));

      const studentsList = [];
      studentsSnap.forEach(docSnap => {
        studentsList.push(docSnap.data());
      });

      const classesList = [];
      classesSnap.forEach(docSnap => {
        const cls = docSnap.data();
        classesList.push({
          id: cls.id,
          name: cls.name,
          batchStart: cls.batchStart,
          batchEnd: cls.batchEnd,
          program: cls.program,
          semester: cls.semester,
          routine: cls.routine || [],
          students: studentsList
            .filter(s => s.classId === cls.id)
            .map(s => ({
              id: s.id,
              name: s.name,
              roll: s.roll,
              group: s.group,
              email: s.email,
              loginId: s.loginId,
              password: s.password
            }))
        });
      });
      
      saveLocalClasses(classesList);
      return classesList;
    } catch (err) {
      console.error("Firebase getClasses failed, using local fallback:", err);
    }
  }
  return getLocalClasses();
}

export async function saveClass(classData) {
  const isEdit = !!classData.id;
  const targetId = classData.id || `cls_${Date.now()}`;

  const cleanClassData = {
    id: targetId,
    name: classData.name,
    batchStart: parseInt(classData.batchStart, 10),
    batchEnd: parseInt(classData.batchEnd, 10),
    program: classData.program,
    semester: parseInt(classData.semester, 10),
    routine: classData.routine || [],
    students: classData.students.map(s => ({
      id: s.id || `stu_${Math.random().toString(36).substr(2, 9)}`,
      name: s.name,
      roll: s.roll,
      group: s.group,
      email: s.email || '',
      loginId: s.loginId,
      password: s.password
    }))
  };

  const localClasses = getLocalClasses();
  if (isEdit) {
    const idx = localClasses.findIndex(c => c.id === targetId);
    if (idx !== -1) localClasses[idx] = cleanClassData;
    else localClasses.push(cleanClassData);
  } else {
    localClasses.push(cleanClassData);
  }
  saveLocalClasses(localClasses);

  if (db) {
    try {
      await setDoc(doc(db, 'classes', targetId), {
        id: cleanClassData.id,
        name: cleanClassData.name,
        batchStart: cleanClassData.batchStart,
        batchEnd: cleanClassData.batchEnd,
        program: cleanClassData.program,
        semester: cleanClassData.semester,
        routine: cleanClassData.routine
      });

      if (isEdit) {
        const q = query(collection(db, 'students'), where('classId', '==', targetId));
        const oldStudents = await getDocs(q);
        const batch = writeBatch(db);
        oldStudents.forEach(docSnap => {
          batch.delete(docSnap.ref);
        });
        await batch.commit();
      }

      if (cleanClassData.students.length > 0) {
        const batch = writeBatch(db);
        cleanClassData.students.forEach(student => {
          const studentRef = doc(db, 'students', student.id);
          batch.set(studentRef, {
            id: student.id,
            classId: targetId,
            name: student.name,
            roll: student.roll,
            group: student.group,
            email: student.email,
            loginId: student.loginId,
            password: student.password
          });
        });
        await batch.commit();
      }
    } catch (err) {
      console.error("Firebase saveClass failed, saved locally:", err);
    }
  }

  return cleanClassData;
}

export async function deleteClass(classId) {
  const localClasses = getLocalClasses();
  const filtered = localClasses.filter(c => c.id !== classId);
  saveLocalClasses(filtered);

  if (db) {
    try {
      const q = query(collection(db, 'students'), where('classId', '==', classId));
      const oldStudents = await getDocs(q);
      const batch = writeBatch(db);
      oldStudents.forEach(docSnap => {
        batch.delete(docSnap.ref);
      });
      batch.delete(doc(db, 'classes', classId));
      await batch.commit();
    } catch (err) {
      console.error("Firebase deleteClass failed, deleted locally:", err);
    }
  }
  return true;
}

export async function validateStudentLogin(loginId, password) {
  const classes = await getClasses();
  for (const cls of classes) {
    const match = cls.students.find(s => s.loginId === loginId && s.password === password);
    if (match) {
      return {
        isAuthenticated: true,
        student: match,
        classId: cls.id,
        className: cls.name,
        program: cls.program,
        semester: cls.semester,
        routine: cls.routine || []
      };
    }
  }
  return { isAuthenticated: false };
}

// ===================================================
// ATTENDANCE LOGS DATABASE APIS
// ===================================================

export async function getAttendanceLogs(studentId) {
  if (db) {
    try {
      const q = query(collection(db, 'attendance'), where('studentId', '==', studentId));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data());
      });
      const allLogs = getLocalAttendance().filter(r => r.studentId !== studentId);
      saveLocalAttendance([...allLogs, ...list]);
      return list;
    } catch (err) {
      console.error("Firebase getAttendanceLogs failed, using local fallback:", err);
    }
  }
  return getLocalAttendance().filter(r => r.studentId === studentId);
}

export async function getAllAttendanceLogs() {
  if (db) {
    try {
      const snap = await getDocs(collection(db, 'attendance'));
      const list = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data());
      });
      saveLocalAttendance(list);
      return list;
    } catch (err) {
      console.error("Firebase getAllAttendanceLogs failed, using local fallback:", err);
    }
  }
  return getLocalAttendance();
}

export async function saveAttendanceEntry(record) {
  const newRecord = { ...record, id: record.id || `att_${Date.now()}_${Math.random().toString(36).substr(2, 5)}` };
  
  const logs = getLocalAttendance();
  logs.push(newRecord);
  saveLocalAttendance(logs);

  if (db) {
    try {
      await setDoc(doc(db, 'attendance', newRecord.id), newRecord);
    } catch (err) {
      console.error("Firebase saveAttendanceEntry failed, saved locally:", err);
    }
  }
  return newRecord;
}

export async function updateAttendanceExit(logId, exitTime, status = 'present') {
  const logs = getLocalAttendance();
  const idx = logs.findIndex(r => r.id === logId);
  let updatedRecord = null;
  if (idx !== -1) {
    logs[idx] = { ...logs[idx], exitTime, status };
    saveLocalAttendance(logs);
    updatedRecord = logs[idx];
  }

  if (db && updatedRecord) {
    try {
      await setDoc(doc(db, 'attendance', logId), updatedRecord);
    } catch (err) {
      console.error("Firebase updateAttendanceExit failed, saved locally:", err);
    }
  }
  return updatedRecord;
}

export async function deleteAttendanceLog(logId) {
  const logs = getLocalAttendance();
  const filtered = logs.filter(r => r.id !== logId);
  saveLocalAttendance(filtered);

  if (db) {
    try {
      await deleteDoc(doc(db, 'attendance', logId));
    } catch (err) {
      console.error("Firebase deleteAttendanceLog failed, deleted locally:", err);
    }
  }
  return filtered;
}

export async function updateAttendanceLog(record) {
  const logs = getLocalAttendance();
  const idx = logs.findIndex(r => r.id === record.id);
  let updatedRecord = null;
  if (idx !== -1) {
    logs[idx] = { ...logs[idx], ...record };
    saveLocalAttendance(logs);
    updatedRecord = logs[idx];
  }

  if (db) {
    try {
      await setDoc(doc(db, 'attendance', record.id), record);
    } catch (err) {
      console.error("Firebase updateAttendanceLog failed, saved locally:", err);
    }
  }
  return updatedRecord;
}

// ===================================================
// SUBJECTS DATABASE APIS
// ===================================================

export async function getSubjects() {
  if (db) {
    try {
      const snap = await getDocs(collection(db, 'subjects'));
      const list = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data());
      });
      saveLocalSubjects(list);
      return list;
    } catch (err) {
      console.error("Firebase getSubjects failed, using local fallback:", err);
    }
  }
  return getLocalSubjects();
}

export async function saveSubject(subjectData) {
  const targetId = subjectData.id || `sub_${Date.now()}`;
  const cleanSub = {
    id: targetId,
    name: subjectData.name,
    department: subjectData.department,
    type: subjectData.type
  };

  const localSubs = getLocalSubjects();
  if (subjectData.id) {
    const idx = localSubs.findIndex(s => s.id === targetId);
    if (idx !== -1) localSubs[idx] = cleanSub;
    else localSubs.push(cleanSub);
  } else {
    localSubs.push(cleanSub);
  }
  saveLocalSubjects(localSubs);

  if (db) {
    try {
      await setDoc(doc(db, 'subjects', targetId), cleanSub);
    } catch (err) {
      console.error("Firebase saveSubject failed, saved locally:", err);
    }
  }
  return cleanSub;
}

export async function deleteSubject(subjectId) {
  const localSubs = getLocalSubjects();
  saveLocalSubjects(localSubs.filter(s => s.id !== subjectId));

  if (db) {
    try {
      await deleteDoc(doc(db, 'subjects', subjectId));
      const profsQuery = query(collection(db, 'professors'), where('subjectIds', 'array-contains', subjectId));
      const profsSnap = await getDocs(profsQuery);
      const batch = writeBatch(db);
      profsSnap.forEach(docSnap => {
        const profData = docSnap.data();
        const updatedSubjectIds = (profData.subjectIds || []).filter(id => id !== subjectId);
        batch.update(docSnap.ref, { subjectIds: updatedSubjectIds });
      });
      await batch.commit();
    } catch (err) {
      console.error("Firebase deleteSubject failed, cleaned locally:", err);
    }
  }
  return true;
}

// ===================================================
// PROFESSORS DATABASE APIS
// ===================================================

export async function getProfessors() {
  const subjectsList = await getSubjects();

  if (db) {
    try {
      const snap = await getDocs(collection(db, 'professors'));
      const list = [];
      snap.forEach(docSnap => {
        const p = docSnap.data();
        const assignedSubjects = subjectsList.filter(s => (p.subjectIds || []).includes(s.id));
        list.push({
          id: p.id,
          name: p.name,
          loginId: p.loginId,
          password: p.password,
          department: p.department,
          subjects: assignedSubjects,
          subjectIds: p.subjectIds || []
        });
      });
      
      saveLocalProfessors(list.map(p => ({
        id: p.id,
        name: p.name,
        loginId: p.loginId,
        password: p.password,
        department: p.department
      })));
      
      const junctions = [];
      list.forEach(p => {
        (p.subjectIds || []).forEach(subId => {
          junctions.push({ professorId: p.id, subjectId: subId });
        });
      });
      saveLocalProfSubjects(junctions);
      
      return list;
    } catch (err) {
      console.error("Firebase getProfessors failed, using local storage:", err);
    }
  }

  const localProfs = getLocalProfessors();
  const localJuncs = getLocalProfSubjects();
  return localProfs.map(p => {
    const subIds = localJuncs.filter(j => j.professorId === p.id).map(j => j.subjectId);
    const assigned = subjectsList.filter(s => subIds.includes(s.id));
    return {
      ...p,
      subjects: assigned,
      subjectIds: subIds
    };
  });
}

export async function saveProfessor(profData) {
  const targetId = profData.id || `prof_${Date.now()}`;
  const cleanProf = {
    id: targetId,
    name: profData.name,
    loginId: profData.loginId,
    password: profData.password,
    department: profData.department,
    subjectIds: profData.subjectIds || []
  };

  const localProfs = getLocalProfessors();
  const baseProf = {
    id: cleanProf.id,
    name: cleanProf.name,
    loginId: cleanProf.loginId,
    password: cleanProf.password,
    department: cleanProf.department
  };
  if (profData.id) {
    const idx = localProfs.findIndex(p => p.id === targetId);
    if (idx !== -1) localProfs[idx] = baseProf;
    else localProfs.push(baseProf);
  } else {
    localProfs.push(baseProf);
  }
  saveLocalProfessors(localProfs);

  let junctions = getLocalProfSubjects().filter(j => j.professorId !== targetId);
  if (cleanProf.subjectIds.length > 0) {
    const newJuncs = cleanProf.subjectIds.map(subId => ({ professorId: targetId, subjectId: subId }));
    junctions = [...junctions, ...newJuncs];
  }
  saveLocalProfSubjects(junctions);

  if (db) {
    try {
      await setDoc(doc(db, 'professors', targetId), cleanProf);
    } catch (err) {
      console.error("Firebase saveProfessor failed, saved locally:", err);
    }
  }
  return cleanProf;
}

export async function deleteProfessor(professorId) {
  const localProfs = getLocalProfessors();
  saveLocalProfessors(localProfs.filter(p => p.id !== professorId));

  const junctions = getLocalProfSubjects();
  saveLocalProfSubjects(junctions.filter(j => j.professorId !== professorId));

  if (db) {
    try {
      await deleteDoc(doc(db, 'professors', professorId));
    } catch (err) {
      console.error("Firebase deleteProfessor failed, deleted locally:", err);
    }
  }
  return true;
}

export async function validateProfessorLogin(loginId, password) {
  const professors = await getProfessors();
  const match = professors.find(p => p.loginId === loginId && p.password === password);
  if (match) {
    return {
      isAuthenticated: true,
      professor: {
        id: match.id,
        name: match.name,
        department: match.department,
        subjects: match.subjects
      }
    };
  }
  return { isAuthenticated: false };
}
