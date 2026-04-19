export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  maxFontSize: number;
  color: string;
  fontWeight: string;
}

export interface Template {
  id: string;
  name: string;
  backgroundImage: string;
  elements: {
    studentName: BoundingBox;
    seminarTitle: BoundingBox;
    verificationCode: BoundingBox;
  };
}
